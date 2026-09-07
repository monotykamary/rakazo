import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { authorizeQueueTarget } from "./queue-target.js";

const scope = { spaceId: "space", threadId: "thread", botId: "bot" };
function fixture() {
  const state = {
    rootParticipantId: "old-run",
    participants: {
      child: {
        participantId: "child",
        parentParticipantId: "old-run",
        placement: { cwd: "projects/child", worktreeId: "worktrees/child" },
      },
      nested: {
        participantId: "nested",
        parentParticipantId: "child",
        placement: { cwd: "projects/nested" },
      },
    },
  };
  const db = {
    runtimeSession: { findUnique: vi.fn().mockResolvedValue({ generation: 2, state }) },
    thread: { findFirst: vi.fn().mockResolvedValue({ historyCompactionGeneration: 2 }) },
  };
  return { db, state, prisma: db as unknown as PrismaClient };
}
it("authorizes nested retained children only within exact session scope", async () => {
  const f = fixture();
  expect(await authorizeQueueTarget(f.prisma, scope, { participantId: "nested" })).toEqual({
    participantId: "nested",
    generation: 2,
    placement: { cwd: "projects/nested" },
  });
  expect(f.db.runtimeSession.findUnique).toHaveBeenCalledWith({
    where: { spaceId_threadId_botId: scope },
  });
  for (const participantId of ["unknown", "old-run", "__proto__", "constructor"]) {
    await expect(authorizeQueueTarget(f.prisma, scope, { participantId })).rejects.toThrow();
  }
});
it("binds the exact saved child cwd/worktree tuple and rejects movement", async () => {
  const f = fixture();
  const binding = await authorizeQueueTarget(f.prisma, scope, { participantId: "child" });
  expect(binding.placement).toEqual({ cwd: "projects/child", worktreeId: "worktrees/child" });
  f.state.participants.child.placement.cwd = "projects/other";
  await expect(
    authorizeQueueTarget(f.prisma, scope, binding, binding.generation, binding.placement),
  ).rejects.toThrow("placement changed");
  f.state.participants.child.placement.cwd = "projects/child";
  f.state.participants.child.placement.worktreeId = "worktrees/other";
  await expect(
    authorizeQueueTarget(f.prisma, scope, binding, binding.generation, binding.placement),
  ).rejects.toThrow("placement changed");
});
it("rejects generation changes and broken or cyclic ancestry", async () => {
  const f = fixture();
  await expect(
    authorizeQueueTarget(f.prisma, scope, { participantId: "child" }, 1),
  ).rejects.toThrow();
  f.db.thread.findFirst.mockResolvedValueOnce({ historyCompactionGeneration: 3 });
  await expect(authorizeQueueTarget(f.prisma, scope, { participantId: "child" })).rejects.toThrow();
  f.state.participants.child.parentParticipantId = "nested";
  await expect(
    authorizeQueueTarget(f.prisma, scope, { participantId: "nested" }),
  ).rejects.toThrow();
  f.state.participants.child.parentParticipantId = "foreign-root";
  await expect(
    authorizeQueueTarget(f.prisma, scope, { participantId: "nested" }),
  ).rejects.toThrow();
});
