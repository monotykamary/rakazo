import type { Actor, WorkReceipt } from "@rakazo/contracts";
import type { DispatchedWork, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const terminal = ["completed", "failed", "cancelled"];
export class WorkScopeError extends Error {}
export function projectPathsOverlap(left: string, right: string): boolean {
  return (
    left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
export function workRoot(work: Pick<DispatchedWork, "projectPath" | "worktreePath">): string {
  return work.worktreePath ?? work.projectPath;
}

export async function getWorkReceipt(prisma: PrismaClient, id: string): Promise<WorkReceipt> {
  const work = await prisma.dispatchedWork.findUniqueOrThrow({
    where: { id },
    include: { run: { include: { bot: true } } },
  });
  return {
    id: work.id,
    taskId: work.taskId,
    runId: work.runId,
    threadId: work.run.threadId,
    workerId: work.workerBotId,
    name: work.run.bot.name,
    projectPath: work.projectPath,
    worktreePath: work.worktreePath,
    status: work.run.status as WorkReceipt["status"],
    error: work.run.error,
    createdAt: work.createdAt.toISOString(),
    completedAt: work.run.completedAt?.toISOString() ?? null,
  };
}
export async function listDispatchedWork(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<WorkReceipt[]> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, temporary: false },
  });
  if (!bot) throw new IsolationError();
  const rows = await prisma.dispatchedWork.findMany({
    where: { parentBotId: botId, spaceId: actor.spaceId, userId: actor.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true },
  });
  return Promise.all(rows.map((row) => getWorkReceipt(prisma, row.id)));
}

/** Run owns lifetime/fencing; this short transaction only arbitrates overlapping resources. */
export async function claimDispatchedWork(
  prisma: PrismaClient,
  runId: string,
  owner: string,
  fence: number,
): Promise<boolean> {
  const candidate = await prisma.dispatchedWork.findUnique({ where: { runId } });
  if (!candidate) return true;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${candidate.computerId} FOR UPDATE`;
    const current = await tx.run.findFirst({
      where: {
        id: runId,
        botId: candidate.workerBotId,
        spaceId: candidate.spaceId,
        userId: candidate.userId,
        status: "running",
        leaseOwner: owner,
        leaseFence: fence,
        leaseExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    const parent = await tx.bot.findFirst({
      where: {
        id: candidate.parentBotId,
        spaceId: candidate.spaceId,
        userId: candidate.userId,
        archivedAt: null,
        temporary: false,
        computerSwitching: false,
        computerId: candidate.computerId,
        computer: { homeKey: candidate.homeKey },
      },
      select: { id: true },
    });
    const worker = await tx.bot.findFirst({
      where: {
        id: candidate.workerBotId,
        spaceId: candidate.spaceId,
        userId: candidate.userId,
        archivedAt: null,
        temporary: true,
        parentBotId: candidate.parentBotId,
        computerId: candidate.computerId,
      },
      select: { id: true },
    });
    if (!current || !parent || !worker)
      throw new WorkScopeError("Dispatched project authority changed; work was not rebound.");
    const peers = await tx.dispatchedWork.findMany({
      where: {
        computerId: candidate.computerId,
        runId: { not: runId },
        run: { status: { notIn: terminal } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const conflict = peers.some(
      (other) =>
        projectPathsOverlap(workRoot(candidate), workRoot(other)) &&
        (other.leaseFence !== null ||
          other.createdAt < candidate.createdAt ||
          (other.createdAt.getTime() === candidate.createdAt.getTime() && other.id < candidate.id)),
    );
    if (conflict) return false;
    await tx.dispatchedWork.update({ where: { id: candidate.id }, data: { leaseFence: fence } });
    return true;
  });
}

/** Regular bots cannot edit a project they have handed to a still-active worker. */
export async function assertNoDispatchedWriteConflict(
  prisma: PrismaClient,
  computerId: string,
  path: string,
  runId: string,
): Promise<void> {
  const peers = await prisma.dispatchedWork.findMany({
    where: { computerId, runId: { not: runId }, run: { status: { notIn: terminal } } },
  });
  if (peers.some((work) => projectPathsOverlap(path, workRoot(work)))) {
    throw new WorkScopeError(
      "This project has queued or running work. Wait for its result or use an independent project/worktree.",
    );
  }
}
