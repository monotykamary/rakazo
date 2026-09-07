import type { Actor, QueueSnapshot } from "@rakazo/contracts";
import { listPremoveQueue, mutatePremoveQueue, type PrismaClient } from "@rakazo/db";
import { PremoveToolInputSchema as inputSchema } from "./premove-tool-schema.js";

function queueView(snapshot: QueueSnapshot) {
  const row = ({ images, ...value }: QueueSnapshot["rows"][number]) => ({
    ...value,
    imageCount: images.length,
  });
  return {
    ...snapshot,
    rows: snapshot.rows.map(row),
    ...(snapshot.editing
      ? {
          editing: {
            ...snapshot.editing,
            rows: snapshot.editing.rows.map((value) => ({ ...row(value), removed: value.removed })),
          },
        }
      : {}),
  };
}
export async function managePremoveTool(
  prisma: PrismaClient,
  actor: Actor,
  scope: { threadId: string; botId: string; runId: string; trigger: string },
  value: unknown,
  executionId: string,
) {
  if (scope.trigger === "messaging" || scope.trigger === "bot_message")
    throw new Error("Private premoves are unavailable in this conversation surface");
  const input = inputSchema.parse(value);
  if (!input.operation)
    return queueView(
      (await listPremoveQueue(prisma, actor, {
        spaceId: actor.spaceId,
        threadId: scope.threadId,
        botId: scope.botId,
      })) as QueueSnapshot,
    );
  if (input.expectedRevision === undefined)
    throw new Error("Read the queue and supply its expectedRevision before editing");
  const result = await mutatePremoveQueue(prisma, actor, {
    threadId: scope.threadId,
    botId: scope.botId,
    requestId: `agent:${scope.runId}:${executionId}`,
    expectedRevision: input.expectedRevision,
    operation: input.operation,
  });
  return { ...result, snapshot: queueView(result.snapshot as QueueSnapshot) };
}
