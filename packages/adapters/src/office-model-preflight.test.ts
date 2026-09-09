import type { Actor, ModelSelection } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createLocalOfficeModelResolver, inspectOfficeModels } from "./office-model-preflight.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
const selection = (modelId: string): ModelSelection => ({
  provider: "pi-provider",
  modelId,
  thinkingLevel: "low",
});
const checkpoint = (modelId: string) => ({
  modelSelection: {
    effective: selection(modelId),
    requested: null,
    status: "applied",
    error: null,
  },
});
function fixture() {
  const source = {
    read: vi.fn().mockResolvedValue({
      catalog: [{ endpoint: "SECRET", apiKey: "SECRET" }],
      profileDefault: selection("startup"),
    }),
    validate: vi.fn(),
  };
  const target = {
    read: vi.fn().mockResolvedValue({ catalog: [], profileDefault: selection("startup") }),
    validate: vi.fn().mockResolvedValue(undefined),
  };
  const resolveOfficeModelRuntime = vi.fn(async (id: string | null) =>
    id === "target" ? target : source,
  );
  const prisma = {
    bot: {
      findFirst: vi.fn().mockResolvedValue({
        computer: { machineId: "source" },
        modelProvider: "pi-provider",
        modelId: "pending-bot",
        thinkingLevel: "low",
      }),
    },
    machine: { findFirst: vi.fn().mockResolvedValue({ status: "paired", lastSeenAt: new Date() }) },
    runtimeSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          state: {
            ...checkpoint("current"),
            agents: { records: [{ record: { checkpoint: { session: checkpoint("worker") } } }] },
          },
        },
      ]),
    },
    runtimeModelPreference: {
      findMany: vi.fn().mockResolvedValue([{ selection: selection("pending-worker") }]),
    },
  };
  return {
    prisma,
    source,
    target,
    resolveOfficeModelRuntime,
    deps: { prisma: prisma as unknown as PrismaClient, resolveOfficeModelRuntime },
  };
}

describe("office Pi authority preflight", () => {
  it("keeps current, retained workers, pending selections and startup default distinct without exporting catalogs", async () => {
    const f = fixture();
    const result = await inspectOfficeModels(f.deps, actor, "bot", "target");
    expect(result.status).toBe("available");
    expect(result.required).toEqual([
      { kind: "current", selection: selection("current") },
      { kind: "current", selection: selection("worker") },
      { kind: "requested", selection: selection("pending-bot") },
      { kind: "requested", selection: selection("pending-worker") },
      { kind: "profileDefault", selection: selection("startup") },
    ]);
    for (const { selection: required } of result.required)
      expect(f.target.validate).toHaveBeenCalledWith(required);
    expect(f.source.validate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("catalog");
    expect(f.resolveOfficeModelRuntime.mock.calls).toEqual([
      ["source", actor],
      ["target", actor],
    ]);
  });
  it("validates startup and pending choices for an office that has not started a session", async () => {
    const f = fixture();
    f.prisma.runtimeSession.findMany.mockResolvedValue([]);
    const result = await inspectOfficeModels(f.deps, actor, "bot", "target");
    expect(result.status).toBe("available");
    expect(result.required.map((item) => item.kind)).toEqual([
      "requested",
      "requested",
      "profileDefault",
    ]);
    expect(f.target.validate).toHaveBeenCalledWith(selection("startup"));
  });

  it("rejects foreign targets before probing either host", async () => {
    const f = fixture();
    f.prisma.machine.findFirst.mockResolvedValue(null);
    await expect(inspectOfficeModels(f.deps, actor, "bot", "foreign")).rejects.toThrow(
      "Target unavailable",
    );
    expect(f.resolveOfficeModelRuntime).not.toHaveBeenCalled();
    expect(f.prisma.runtimeSession.findMany).not.toHaveBeenCalled();
  });
  it("rejects foreign bots before target discovery", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValue(null);
    await expect(inspectOfficeModels(f.deps, actor, "bot", "target")).rejects.toThrow(
      "Office access unavailable",
    );
    expect(f.prisma.machine.findFirst).not.toHaveBeenCalled();
    expect(f.resolveOfficeModelRuntime).not.toHaveBeenCalled();
  });
  it.each([
    "disconnected",
    "no-service",
    "no-target",
    "probe-error",
    "missing-model",
    "thinking",
    "default-drift",
    "unknown-default",
    "unknown-current",
    "unknown-worker",
    "malformed-request",
  ])("fails closed: %s", async (failure) => {
    const f = fixture();
    if (failure === "disconnected")
      f.prisma.machine.findFirst.mockResolvedValue({ status: "paired", lastSeenAt: new Date(0) });
    if (failure === "no-target")
      f.resolveOfficeModelRuntime
        .mockResolvedValueOnce(f.source)
        .mockResolvedValueOnce(null as never);
    if (failure === "probe-error")
      f.target.read.mockRejectedValue(new Error("SECRET endpoint auth.json"));
    if (failure === "missing-model" || failure === "thinking")
      f.target.validate.mockRejectedValue(new Error("SECRET unavailable"));
    if (failure === "default-drift")
      f.target.read.mockResolvedValue({ catalog: [], profileDefault: selection("different") });
    if (failure === "unknown-default")
      f.source.read.mockResolvedValue({ catalog: [], profileDefault: null });
    if (failure === "unknown-current")
      f.prisma.runtimeSession.findMany.mockResolvedValue([{ state: {} }]);
    if (failure === "unknown-worker")
      f.prisma.runtimeSession.findMany.mockResolvedValue([
        {
          state: {
            ...checkpoint("current"),
            agents: { records: [{ record: { checkpoint: { session: {} } } }] },
          },
        },
      ]);
    if (failure === "malformed-request")
      f.prisma.runtimeModelPreference.findMany.mockResolvedValue([
        { selection: { provider: "pi-provider" } },
      ]);
    const result = await inspectOfficeModels(
      { ...f.deps, ...(failure === "no-service" ? { resolveOfficeModelRuntime: undefined } : {}) },
      actor,
      "bot",
      "target",
    );
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("extracts retained legacy worker identities through the existing snapshot adapter", async () => {
    const f = fixture();
    f.prisma.runtimeSession.findMany.mockResolvedValue([
      {
        state: {
          ...checkpoint("current"),
          rootParticipantId: "root",
          participants: {
            child: {
              participantId: "child",
              parentParticipantId: "root",
              status: "paused",
              session: checkpoint("legacy-worker"),
            },
          },
        },
      },
    ]);
    const result = await inspectOfficeModels(f.deps, actor, "bot", null);
    expect(result.required).toContainEqual({
      kind: "current",
      selection: selection("legacy-worker"),
    });
  });
});

describe("local office model authority", () => {
  it("requires the current deployment owner and never substitutes local Pi for a remote office", async () => {
    const findUnique = vi.fn().mockResolvedValue({ ownerUserId: "owner" });
    const prisma = { deploymentSettings: { findUnique } } as unknown as PrismaClient;
    const models = { read: vi.fn(), validate: vi.fn() };
    const resolve = createLocalOfficeModelResolver(prisma, models);
    expect(await resolve("remote", actor)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(await resolve(null, { ...actor, userId: "other" })).toBeNull();
    expect(await resolve(null, actor)).toBe(models);
    expect(models.read).not.toHaveBeenCalled();
    expect(models.validate).not.toHaveBeenCalled();
    expect(await createLocalOfficeModelResolver(prisma)(null, actor)).toBeNull();
  });
});
