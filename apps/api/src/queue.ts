import { ORPCError } from "@orpc/server";
import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, QueueMutation, QueueSnapshot } from "@rakazo/contracts";
import {
  IsolationError,
  listPremoveQueue,
  mutatePremoveQueue,
  PremoveResumeUnavailable,
  type PrismaClient,
  wakePremoveQueue,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export async function listQueue(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; botId: string },
): Promise<QueueSnapshot> {
  try {
    return (await listPremoveQueue(prisma, actor, {
      ...input,
      spaceId: actor.spaceId,
    })) as QueueSnapshot;
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}
export async function mutateQueue(
  prisma: PrismaClient,
  actor: Actor,
  input: QueueMutation,
  jobs?: JobPublisher,
) {
  try {
    const result = await mutatePremoveQueue(prisma, actor, input);
    if (result.ok && !result.snapshot.paused && jobs) {
      const runId = await wakePremoveQueue(prisma, actor, { ...input, spaceId: actor.spaceId });
      if (runId)
        await jobs
          .enqueue(runContinueJob(runId))
          .catch((error) => getLogger().error("queue wake notification", error));
    }
    return result;
  } catch (error) {
    if (error instanceof PremoveResumeUnavailable) {
      return {
        version: 1 as const,
        requestId: input.requestId,
        ok: false,
        error: error.message,
        snapshot: await listQueue(prisma, actor, input),
      };
    }
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}
