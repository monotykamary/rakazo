import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  assertQueuePlacementComputer,
  captureQueuePlacement,
  setRuntimePlacement,
} from "./runtime-placement.js";

const scope = {
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  leaseOwner: "worker",
  leaseFence: 1,
};
const placement = {
  computerId: "computer",
  homeKey: "home",
  projectPath: "projects/repo",
  worktreePath: "worktrees/feature",
};
describe("server-owned queue placement", () => {
  it("captures known worktree once even when the conversation later changes project", async () => {
    const tx = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({ computer: { id: "computer", homeKey: "home" } }),
      },
      runtimePlacement: { findUnique: vi.fn().mockResolvedValue({ ...placement, revision: 3 }) },
    };
    const captured = await captureQueuePlacement(tx as unknown as Prisma.TransactionClient, scope);
    tx.runtimePlacement.findUnique.mockResolvedValue({
      ...placement,
      projectPath: "projects/other",
      revision: 4,
    });
    expect(captured).toMatchObject({
      kind: "project",
      projectPath: "projects/repo",
      worktreePath: "worktrees/feature",
      revision: 3,
    });
    expect(
      (await captureQueuePlacement(tx as unknown as Prisma.TransactionClient, scope)).projectPath,
    ).toBe("projects/other");
  });
  it("resolves a fresh bot's unbound queue rows to the authorized root computer", async () => {
    const tx = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({ computer: { id: "computer", homeKey: "home" } }),
      },
      runtimePlacement: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const captured = await captureQueuePlacement(tx as unknown as Prisma.TransactionClient, scope);
    expect(captured).toMatchObject({
      kind: "unbound",
      computerId: "computer",
      projectPath: null,
      worktreePath: null,
    });
    await expect(
      assertQueuePlacementComputer(tx as unknown as PrismaClient, scope, captured),
    ).resolves.toBeUndefined();
  });

  it("holds queued rows when the bot's computer changed before dispatch", async () => {
    const tx = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({ computer: { id: "computer", homeKey: "home" } }),
      },
      runtimePlacement: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const captured = await captureQueuePlacement(tx as unknown as Prisma.TransactionClient, scope);
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(assertQueuePlacementComputer(prisma, scope, captured)).rejects.toThrow(
      "computer changed",
    );
  });

  it("dispatches a computerless queued row only while the bot still has no computer", async () => {
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot" }) },
    } as unknown as PrismaClient;
    await expect(
      assertQueuePlacementComputer(prisma, scope, {
        version: 1,
        kind: "none",
        computerId: null,
        homeKey: null,
        projectPath: null,
        worktreePath: null,
        revision: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertQueuePlacementComputer(prisma, scope, {
        version: 1,
        kind: "unbound",
        computerId: null,
        homeKey: null,
        projectPath: null,
        worktreePath: null,
        revision: 0,
      }),
    ).resolves.toBeUndefined();
  });
  it("requires provider path authorization and a live lease before setting placement", async () => {
    const tx = {
      $queryRaw: vi.fn(),
      run: { findFirst: vi.fn().mockResolvedValue({ id: "run" }) },
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot" }) },
      runtimePlacement: { upsert: vi.fn() },
    };
    const prisma = {
      $transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    const authorize = vi.fn().mockResolvedValue(undefined);
    await setRuntimePlacement(prisma, scope, placement, authorize);
    expect(authorize).toHaveBeenCalledWith(placement);
    expect(tx.runtimePlacement.upsert).toHaveBeenCalledOnce();
    tx.run.findFirst.mockResolvedValue(null);
    await expect(setRuntimePlacement(prisma, scope, placement, authorize)).rejects.toThrow(
      "authority changed",
    );
    await expect(
      setRuntimePlacement(prisma, scope, { ...placement, projectPath: "../escape" }, authorize),
    ).rejects.toThrow("Invalid project");
    expect(tx.runtimePlacement.upsert).toHaveBeenCalledOnce();
  });
  it("rejects a changed computer instead of rebasing paths silently", async () => {
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(
      assertQueuePlacementComputer(prisma, scope, {
        ...placement,
        version: 1,
        kind: "project",
        revision: 1,
      }),
    ).rejects.toThrow("computer changed");
  });
});
