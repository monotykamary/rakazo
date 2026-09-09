import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  MANAGE_OFFICE_TOOL,
  manageOfficeTool,
  officeActionRequiresExplicitApproval,
} from "./office-tools.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
const scope = { botId: "bot", runId: "run", leaseOwner: "worker", leaseFence: 7 };
function fixture(runtime = "managed") {
  const selected = {
    provider: "pi-provider",
    modelId: "actual-model",
    thinkingLevel: "low" as const,
  };
  const modelRuntime = {
    read: vi
      .fn()
      .mockResolvedValue({ catalog: [{ endpoint: "SECRET" }], profileDefault: selected }),
    validate: vi.fn().mockResolvedValue(undefined),
  };
  const resolveOfficeModelRuntime = vi.fn().mockResolvedValue(modelRuntime);
  const prisma = {
    runtimeSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          state: {
            modelSelection: {
              requested: null,
              effective: selected,
              status: "applied",
              error: null,
            },
          },
        },
      ]),
    },
    runtimeModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
    officeMoveIntent: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({
        id: "intent",
        status: "pending",
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        runId: "run",
        machineId: "target",
      }),
    },
    externalEffect: {
      findFirst: vi.fn().mockResolvedValue({
        idempotencyKey: "stable-key",
        request: { action: "move", machineId: "target" },
      }),
    },
    run: { findFirst: vi.fn().mockResolvedValue({ id: "run" }) },
    bot: {
      findFirst: vi.fn().mockResolvedValue({
        computer: {
          id: "computer",
          kind: "docker",
          state: "running",
          machineId: null,
          providerRef: "SECRET",
          homeKey: "SECRET",
        },
      }),
    },
    machine: {
      findMany: vi.fn().mockResolvedValue([{ id: "target", runnerToken: "SECRET" }]),
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: "target", status: "paired", lastSeenAt: new Date() }),
    },
  };
  return {
    prisma,
    modelRuntime,
    resolveOfficeModelRuntime,
    deps: { prisma: prisma as unknown as PrismaClient, runtime, resolveOfficeModelRuntime },
  };
}

describe("manage_office", () => {
  it("preflights an optional plan target without a receipt or mutation", async () => {
    const { deps, prisma, modelRuntime } = fixture();
    expect(officeActionRequiresExplicitApproval({ action: "plan", machineId: "target" })).toBe(
      false,
    );
    const result = await manageOfficeTool(deps, actor, scope, {
      action: "plan",
      machineId: "target",
    });
    expect(result.models).toMatchObject({ authority: "pi", status: "available" });
    expect(modelRuntime.validate).toHaveBeenCalled();
    expect(prisma.officeMoveIntent.upsert).not.toHaveBeenCalled();
  });
  it("refuses foreign plan targets before any Pi probe and rejects caller availability claims", async () => {
    const { deps, resolveOfficeModelRuntime } = fixture();
    await expect(
      manageOfficeTool(deps, actor, scope, { action: "plan", machineId: "foreign" }),
    ).rejects.toThrow("Target unavailable");
    await expect(
      manageOfficeTool(deps, actor, scope, {
        action: "plan",
        machineId: "target",
        available: true,
      }),
    ).rejects.toThrow();
    expect(resolveOfficeModelRuntime).not.toHaveBeenCalled();
  });
  it("does not queue an approved move when Pi cannot validate destination models", async () => {
    const { deps, prisma, modelRuntime } = fixture();
    modelRuntime.validate.mockRejectedValue(new Error("SECRET endpoint key"));
    const result = await manageOfficeTool(
      deps,
      actor,
      scope,
      { action: "move", machineId: "target" },
      "receipt",
    );
    expect(result).toMatchObject({
      status: "blocked",
      queued: false,
      models: { status: "unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(prisma.officeMoveIntent.upsert).not.toHaveBeenCalled();
  });
  it("exports one action tool and fail-closed approval classification", () => {
    expect(MANAGE_OFFICE_TOOL.name).toBe("manage_office");
    for (const action of ["inspect", "plan"])
      expect(officeActionRequiresExplicitApproval({ action })).toBe(false);
    for (const input of [
      { action: "link" },
      { action: "move", machineId: null },
      {},
      { action: "inspect", approved: true },
    ])
      expect(officeActionRequiresExplicitApproval(input)).toBe(true);
  });
  it("scopes reads to owner and live lease and projects only safe fields", async () => {
    const { deps, prisma } = fixture();
    const result = await manageOfficeTool(deps, actor, scope, { action: "inspect" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "run",
          botId: "bot",
          userId: "owner",
          spaceId: "space",
          leaseOwner: "worker",
          leaseFence: 7,
          leaseExpiresAt: { gt: expect.any(Date) },
          status: "running",
        }),
      }),
    );
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot", ...actor } }),
    );
    expect(prisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...actor, status: "paired" } }),
    );
  });
  it("refuses expired or fenced runs before reading placement", async () => {
    const { deps, prisma } = fixture();
    prisma.run.findFirst.mockResolvedValue(null);
    await expect(manageOfficeTool(deps, actor, scope, { action: "inspect" })).rejects.toThrow(
      "unavailable",
    );
    expect(prisma.bot.findFirst).not.toHaveBeenCalled();
    expect(prisma.machine.findMany).not.toHaveBeenCalled();
  });
  it("refuses foreign bots and targets without exposing their state", async () => {
    const { deps, prisma } = fixture();
    await expect(
      manageOfficeTool(deps, actor, scope, { action: "move", machineId: "foreign" }),
    ).rejects.toThrow("Target unavailable");
    prisma.bot.findFirst.mockResolvedValue(null);
    await expect(manageOfficeTool(deps, actor, scope, { action: "plan" })).rejects.toThrow(
      "Office access unavailable",
    );
  });
  it("never turns model requests into approvals or queued relocation", async () => {
    const { deps } = fixture();
    for (const input of [
      { action: "move", machineId: "target" },
      { action: "move", machineId: null },
    ]) {
      await expect(manageOfficeTool(deps, actor, scope, input)).rejects.toThrow(
        "Explicit approval receipt required",
      );
    }
    await expect(manageOfficeTool(deps, actor, scope, { action: "link" })).rejects.toThrow();
    await expect(
      manageOfficeTool(deps, actor, scope, { action: "link", approved: true }),
    ).rejects.toThrow();
  });
  it("really queues only a receipt-backed move and reports durable status on inspection", async () => {
    const { deps, prisma } = fixture();
    expect(
      await manageOfficeTool(
        deps,
        actor,
        scope,
        { action: "move", machineId: "target" },
        "receipt",
      ),
    ).toMatchObject({ status: "pending", changed: false, queued: true, intent: { id: "intent" } });
    expect(prisma.officeMoveIntent.upsert).toHaveBeenCalledTimes(1);
    prisma.officeMoveIntent.findMany.mockResolvedValue([
      { id: "intent", status: "completed", resultComputerId: "destination" },
    ]);
    expect(await manageOfficeTool(deps, actor, scope, { action: "inspect" })).toMatchObject({
      queued: false,
      moves: [{ status: "completed" }],
    });
    expect(prisma.officeMoveIntent.upsert).toHaveBeenCalledTimes(1);
  });
  it("plainly reports unsupported native cutover and independent manual deployment", async () => {
    const { deps } = fixture("pi-local");
    const result = await manageOfficeTool(deps, actor, scope, {
      action: "move",
      machineId: "target",
    });
    expect(result.nextStep).toContain("Native cutover is unsupported");
    expect(result.capabilities).toMatchObject({
      nativeAutomaticExport: false,
      pairedComputeRequiresOriginalControlPlane: true,
    });
    expect(result.capabilities.independentServerManualScript).toBe(
      "infra/compose/deploy-server.sh",
    );
  });
});
