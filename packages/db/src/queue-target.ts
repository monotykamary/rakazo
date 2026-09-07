import type { QueueTarget } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

type Scope = { spaceId: string; threadId: string; botId: string };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Child authority comes only from the retained session in this exact private scope. */
export async function authorizeQueueTarget(
  db: Prisma.TransactionClient | PrismaClient,
  scope: Scope,
  target: QueueTarget,
  expectedGeneration?: number,
  expectedPlacement?: { cwd: string; worktreeId?: string },
) {
  const session = await db.runtimeSession.findUnique({ where: { spaceId_threadId_botId: scope } });
  const thread = await db.thread.findFirst({
    where: { id: scope.threadId, spaceId: scope.spaceId },
    select: { historyCompactionGeneration: true },
  });
  if (
    !session ||
    !thread ||
    session.generation !== thread.historyCompactionGeneration ||
    (expectedGeneration !== undefined && expectedGeneration !== session.generation)
  )
    throw new Error("Queued participant session is unavailable");
  const state = object(session.state);
  const participants = object(state.participants);
  const visited = new Set<string>();
  let id = target.participantId;
  while (id !== state.rootParticipantId) {
    if (visited.has(id) || !Object.hasOwn(participants, id))
      throw new Error("Participant is outside this runtime session");
    visited.add(id);
    const child = object(participants[id]);
    if (child.participantId !== id || typeof child.parentParticipantId !== "string")
      throw new Error("Participant is outside this runtime session");
    id = child.parentParticipantId;
  }
  if (!visited.size) throw new Error("Target must be a retained child participant");
  const placement = object(object(participants[target.participantId]).placement);
  if (
    typeof placement.cwd !== "string" ||
    !placement.cwd.trim() ||
    placement.cwd.length > 4096 ||
    placement.cwd.includes("\0") ||
    placement.cwd.split(/[\\/]/).includes("..") ||
    (placement.worktreeId !== undefined && typeof placement.worktreeId !== "string")
  )
    throw new Error("Participant placement is unavailable");
  if (
    expectedPlacement &&
    (placement.cwd !== expectedPlacement.cwd ||
      placement.worktreeId !== expectedPlacement.worktreeId)
  )
    throw new Error("Queued participant placement changed");
  return {
    participantId: target.participantId,
    generation: session.generation,
    placement: {
      cwd: placement.cwd,
      ...(placement.worktreeId === undefined ? {} : { worktreeId: placement.worktreeId as string }),
    },
  };
}
