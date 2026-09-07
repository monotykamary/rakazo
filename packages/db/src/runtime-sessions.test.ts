import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRuntimeSession, RuntimeSessionConflict } from "./runtime-sessions.js";

const scope = {
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  leaseOwner: "worker",
  leaseFence: 1,
};
function fixture() {
  let row: { revision: number; generation: number; state: unknown } | null = null;
  const tx = {
    $queryRaw: vi.fn(),
    run: { findFirst: vi.fn().mockResolvedValue({ id: "run" }) },
    thread: { findFirst: vi.fn().mockResolvedValue({ historyCompactionGeneration: 0 }) },
    runtimeSession: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ create, update }) => {
        row = row ? { ...row, ...update } : create;
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (db: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, tx };
}
describe("opaque runtime sessions", () => {
  it("restores scoped state and serializes revisioned saves", async () => {
    const { prisma, tx } = fixture();
    const session = await createRuntimeSession(prisma, scope);
    expect(session.restore).toBeUndefined();
    await Promise.all([session.save({ leaf: "first" }), session.save({ leaf: "second" })]);
    expect((await createRuntimeSession(prisma, scope)).restore).toEqual({ leaf: "second" });
    expect(tx.runtimeSession.findUnique).toHaveBeenCalledWith({
      where: { spaceId_threadId_botId: { spaceId: "space", threadId: "thread", botId: "bot" } },
    });
  });
  it("rejects stale concurrent writers and cleared history generations", async () => {
    const { prisma, tx } = fixture();
    const first = await createRuntimeSession(prisma, scope);
    const second = await createRuntimeSession(prisma, scope);
    await first.save({ leaf: "one" });
    await expect(second.save({ leaf: "two" })).rejects.toBeInstanceOf(RuntimeSessionConflict);
    tx.thread.findFirst.mockResolvedValue({ historyCompactionGeneration: 1 });
    await expect(first.save({ leaf: "stale" })).rejects.toBeInstanceOf(RuntimeSessionConflict);
  });
  it("checks live lease before restore and every checkpoint", async () => {
    const { prisma, tx } = fixture();
    const session = await createRuntimeSession(prisma, scope);
    tx.run.findFirst.mockResolvedValue(null);
    await expect(session.save({ leaf: "stale" })).rejects.toBeInstanceOf(RuntimeSessionConflict);
    await expect(createRuntimeSession(prisma, scope)).rejects.toBeInstanceOf(
      RuntimeSessionConflict,
    );
    expect(tx.runtimeSession.upsert).not.toHaveBeenCalled();
  });
});
