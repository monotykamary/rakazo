import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { inspectExecution } from "./execution.js";

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
describe("execution inspection access", () => {
  it("returns not found before querying events for foreign runs", async () => {
    const prisma = {
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      event: { findMany: vi.fn() },
    };
    await expect(
      inspectExecution(prisma as unknown as PrismaClient, actor, { runId: "foreign", limit: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.event.findMany).not.toHaveBeenCalled();
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space",
          userId: "user",
          thread: { spaceId: "space", userId: "user" },
        }),
      }),
    );
  });
  it("bounds retained event query and returns only actual payloads", async () => {
    const prisma = {
      run: {
        findFirst: vi.fn().mockResolvedValue({
          id: "run",
          threadId: "thread",
          botId: "bot",
          status: "running",
          trigger: "user",
          sourceMessageId: null,
          sourceMessage: null,
        }),
      },
      event: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "event",
            seq: 4,
            spaceId: "space",
            threadId: "thread",
            runId: "run",
            botId: "bot",
            type: "thread.subagent",
            createdAt: new Date("2026-01-01"),
            payload: { agentId: "child", status: "running" },
          },
        ]),
      },
    };
    const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
      runId: "run",
      afterSeq: 3,
      limit: 5,
    });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "run", threadId: "thread", spaceId: "space", seq: { gt: 3 } },
      orderBy: { seq: "asc" },
      take: 6,
    });
    expect(result.events[0]!.payload).toEqual({ agentId: "child", status: "running" });
    expect(result.nextCursor).toBe(4);
  });
});
