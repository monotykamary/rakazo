import { LocalPiModelRuntimeService, PiModelRuntimeError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { readPiModelRuntime } from "./model-runtime.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const profile = {
  catalog: [
    {
      provider: "extension",
      id: "model",
      label: "Model",
      billing: "Pi",
      reasoning: false,
      thinkingLevels: ["off" as const],
    },
  ],
  profileDefault: { provider: "extension", modelId: "model", thinkingLevel: "off" as const },
};

function prisma(
  state: unknown,
  botModel: { provider: string | null; modelId: string | null; thinkingLevel: string | null } = {
    provider: null,
    modelId: null,
    thinkingLevel: null,
  },
) {
  return {
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot",
        modelProvider: botModel.provider,
        modelId: botModel.modelId,
        thinkingLevel: botModel.thinkingLevel,
        thread: { id: "thread" },
      })),
    },
    runtimeSession: { findUnique: vi.fn(async () => ({ state })) },
    runtimeModelPreference: { findUnique: vi.fn(async () => null) },
  } as unknown as PrismaClient;
}

describe("readPiModelRuntime", () => {
  it.each([
    "PI_START_FAILED",
    "PI_DISCONNECTED",
    "PI_WORKSPACE_UNAVAILABLE",
    "PI_PROTOCOL_FAILED",
    "PI_DISCOVERY_TIMEOUT",
  ] as const)("returns safe actionable %s without private causes", async (code) => {
    const result = await readPiModelRuntime({
      prisma: prisma({}),
      actor,
      scope: {},
      models: {
        validate: vi.fn(),
        read: vi
          .fn()
          .mockRejectedValue(
            new PiModelRuntimeError(code, { cause: new Error("fake-private-detail") }),
          ),
      },
    });
    expect(result.availability).toEqual({ status: "unavailable", error: code });
    expect(result.catalog).toEqual([]);
    expect(result.profileDefault).toBeNull();
    expect(JSON.stringify(result)).not.toContain("fake-private-detail");
  });

  it("does not expose untyped errors or accept spoofed codes", async () => {
    const result = await readPiModelRuntime({
      prisma: prisma({}),
      actor,
      scope: {},
      models: {
        validate: vi.fn(),
        read: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("fake-private-detail"), { code: "fake-private-detail" }),
          ),
      },
    });
    expect(result.availability).toEqual({ status: "unavailable", error: "PI_DISCOVERY_FAILED" });
  });

  it("propagates caller cancellation instead of claiming Pi unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(
      readPiModelRuntime({
        prisma: prisma({}),
        actor,
        scope: {},
        signal: controller.signal,
        models: { validate: vi.fn(), read: vi.fn().mockRejectedValue(reason) },
      }),
    ).rejects.toBe(reason);
  });
  it.each(["thread", "bot", "participant"])(
    "authorizes %s before a profile probe",
    async (foreign) => {
      const db = prisma({});
      if (foreign === "thread") vi.mocked(db.thread.findFirst).mockResolvedValueOnce(null);
      if (foreign === "bot") vi.mocked(db.bot.findFirst).mockResolvedValueOnce(null);
      const read = vi.fn(async () => profile);
      const supportsCheckpoint = vi.fn(() => true);
      await expect(
        readPiModelRuntime({
          prisma: db,
          actor,
          scope: {
            botId: "bot",
            threadId: "thread",
            ...(foreign === "participant" ? { participantId: "invented" } : {}),
          },
          models: { read, validate: vi.fn(), supportsCheckpoint },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(read).not.toHaveBeenCalled();
      expect(supportsCheckpoint).not.toHaveBeenCalled();
    },
  );
  it("has no static fallback without a Pi service", async () => {
    await expect(
      readPiModelRuntime({ prisma: prisma({}), actor, scope: {} }),
    ).resolves.toMatchObject({
      catalog: [],
      profileDefault: null,
      current: null,
      availability: { status: "unavailable", error: "PI_NOT_CONFIGURED" },
    });
  });
  it("reads the global catalog directly from Pi", async () => {
    const read = vi.fn(async () => profile);

    await expect(
      readPiModelRuntime({
        prisma: prisma({}),
        actor,
        scope: {},
        models: { read, validate: vi.fn(), supportsCheckpoint: vi.fn(() => false) },
      }),
    ).resolves.toMatchObject({ ...profile, availability: { status: "available", error: null } });
    expect(read).toHaveBeenCalledOnce();
  });

  it("forwards explicit refresh without changing ordinary read calls", async () => {
    const read = vi.fn(async () => profile);
    const signal = new AbortController().signal;
    const models = { read, validate: vi.fn() };

    await readPiModelRuntime({
      prisma: prisma({}),
      actor,
      scope: { refresh: true },
      signal,
      models,
    });
    expect(read).toHaveBeenLastCalledWith(signal, undefined, { refresh: true });

    await readPiModelRuntime({ prisma: prisma({}), actor, scope: {}, signal, models });
    expect(read).toHaveBeenLastCalledWith(signal);
  });

  it("reads bot selection state afresh while reusing the runtime catalog", async () => {
    const botModel = { provider: "extension", modelId: "first", thinkingLevel: null };
    const db = prisma({}, botModel);
    const discover = vi.fn(async () => profile);
    let cachedProfile: typeof profile | undefined;
    const read = vi.fn(async () => (cachedProfile ??= await discover()));
    const models = { read, validate: vi.fn(), supportsCheckpoint: vi.fn(() => true) };
    const scope = { botId: "bot", threadId: "thread" };

    const first = await readPiModelRuntime({ prisma: db, actor, scope, models });
    botModel.modelId = "second";
    const second = await readPiModelRuntime({ prisma: db, actor, scope, models });

    expect(first.selection?.requested?.modelId).toBe("first");
    expect(second.selection?.requested?.modelId).toBe("second");
    expect(first.catalog).toEqual(second.catalog);
    expect(read).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledOnce();
    expect(db.runtimeSession.findUnique).toHaveBeenCalledTimes(4);
  });

  it("offers the configured profile to an authorized bot before its first session", async () => {
    const models = new LocalPiModelRuntimeService({
      cwd: "/fixture",
      sessionDir: "/fixture/sessions",
    });
    const read = vi.spyOn(models, "read").mockResolvedValue(profile);
    const result = await readPiModelRuntime({
      prisma: prisma(null),
      actor,
      scope: { botId: "bot" },
      models,
    });
    expect(result).toMatchObject({
      ...profile,
      current: null,
      availability: { status: "available", error: null },
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not claim a root catalog for a mismatched project checkpoint", async () => {
    const read = vi.fn(async () => profile);
    const checkpoint = { runtime: "pi-local", cwdHash: "project-hash" };

    await expect(
      readPiModelRuntime({
        prisma: prisma(checkpoint),
        actor,
        scope: { botId: "bot", threadId: "thread" },
        models: { read, validate: vi.fn(), supportsCheckpoint: vi.fn(() => false) },
      }),
    ).resolves.toMatchObject({
      catalog: [],
      availability: { status: "unavailable", error: "PI_SCOPE_UNSUPPORTED" },
    });
    expect(read).not.toHaveBeenCalled();
  });
});
