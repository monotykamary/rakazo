import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("executor database capacity recovery", () => {
  it.each(["53300", "P2037", "unrelated"])(
    "preserves checkpoint and fences for %s",
    async (code) => {
      const capacity = code !== "unrelated";
      const error = Object.assign(
        new Error(capacity ? "Database capacity" : "Unexpected setup failure"),
        { code },
      );
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const enqueue = vi.fn(async () => undefined);
      const runtimeRun = vi.fn();
      const prisma = {
        run: {
          findUnique: vi.fn(async () => ({
            id: "run-1",
            botId: "bot-1",
            threadId: "thread-1",
            taskId: "task-1",
            userId: "user-1",
            spaceId: "space-1",
            status: "queued",
            checkpoint: "takeover-skipped",
            leaseFence: 0,
            trigger: "messaging",
            sourceMessageId: "source-1",
          })),
          findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
          updateMany,
        },
        bot: {
          findUniqueOrThrow: vi.fn(async () => ({
            computerId: "computer-1",
            computerSwitching: false,
          })),
        },
        computer: {
          findUnique: vi.fn(async () => null),
          findUniqueOrThrow: vi.fn(async () => ({ scope: "private", state: "running" })),
        },
        computerExecutionLease: {
          updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        attempt: {
          create: vi.fn(async () => ({ id: "attempt-1" })),
          update: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        message: {
          findUnique: vi.fn(async () => {
            throw error;
          }),
        },
      } as unknown as PrismaClient;
      const executor = createRunExecutor({
        prisma,
        runtime: { describe: () => ({ id: "scripted" }), run: runtimeRun },
        jobs: { enqueue },
        secrets: [],
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      const work = executor.continueRun("run-1", "worker-1");
      if (capacity) await expect(work).resolves.toBeUndefined();
      else await expect(work).rejects.toThrow("Run setup failed; retrying");
      expect(updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: "run-1", status: "running", leaseOwner: "worker-1", leaseFence: 1 },
          data: expect.objectContaining({
            status: "queued",
            checkpoint: "takeover-skipped",
            error: capacity ? null : "Run setup failed; retrying",
          }),
        }),
      );
      expect(enqueue).toHaveBeenCalledTimes(capacity ? 1 : 0);
      if (capacity)
        expect(enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ name: "run.continue", availableAt: expect.any(Date) }),
        );
      expect(runtimeRun).not.toHaveBeenCalled();
    },
  );
});
