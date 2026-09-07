import { ORPCError } from "@orpc/server";
import { type Actor, MessageBlock, type ProductEvent } from "@rakazo/contracts";
import { type ExecutionRunEvidence, projectExecutionPage } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

const runSelect = {
  id: true,
  threadId: true,
  botId: true,
  bot: { select: { name: true } },
  status: true,
  trigger: true,
  sourceMessageId: true,
  sourceMessage: { select: { id: true, runId: true, blocks: true, replyToMessageId: true } },
} satisfies Prisma.RunSelect;

export async function inspectExecution(
  prisma: PrismaClient,
  actor: Actor,
  input: { runId: string; afterSeq?: number; limit: number },
) {
  const authorized = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    thread: { spaceId: actor.spaceId, userId: actor.userId },
    bot: { archivedAt: null },
  };
  const run = await prisma.run.findFirst({
    where: { ...authorized, id: input.runId },
    select: runSelect,
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const afterSeq = input.afterSeq ?? -1;
  const rows = await prisma.event.findMany({
    where: {
      runId: input.runId,
      threadId: run.threadId,
      spaceId: actor.spaceId,
      seq: { gt: afterSeq },
    },
    orderBy: { seq: "asc" },
    take: input.limit + 1,
  });
  const events = rows.map(
    (row): ProductEvent => ({
      id: row.id,
      spaceId: row.spaceId,
      threadId: row.threadId,
      botId: row.botId,
      runId: row.runId ?? undefined,
      seq: row.seq,
      type: row.type as ProductEvent["type"],
      createdAt: row.createdAt.toISOString(),
      payload: row.payload as Record<string, unknown>,
    }),
  );
  const messageIds = [
    ...new Set(
      events
        .slice(0, input.limit)
        .flatMap((event) =>
          typeof event.payload.messageId === "string" ? [event.payload.messageId] : [],
        ),
    ),
  ];
  const clauses: Prisma.RunWhereInput[] = [];
  if (messageIds.length) {
    clauses.push({ sourceMessageId: { in: messageIds } });
    clauses.push({ sourceMessage: { replyToMessageId: { in: messageIds } } });
    for (const messageId of messageIds)
      clauses.push({
        sourceMessage: {
          blocks: {
            array_contains: [{ kind: "bot_message_received", returnToMessageId: messageId }],
          },
        },
      });
  }
  if (run.sourceMessage?.runId && run.sourceMessage.runId !== run.id)
    clauses.push({ id: run.sourceMessage.runId });
  const related = clauses.length
    ? await prisma.run.findMany({
        where: { ...authorized, id: { not: run.id }, OR: clauses },
        select: runSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 51,
      })
    : [];
  const visible = [run, ...related.slice(0, 50)];
  const authorizedIds = new Set(visible.map((item) => item.id));
  const links: ExecutionRunEvidence[] = visible.map((item) => {
    const parsed = MessageBlock.array().safeParse(item.sourceMessage?.blocks);
    const peer = parsed.success
      ? parsed.data.find((block) => block.kind === "bot_message_received")
      : undefined;
    return {
      runId: item.id,
      botId: item.botId,
      botName: item.bot.name,
      status: item.status,
      trigger: item.trigger,
      sourceMessageId: item.sourceMessageId ?? undefined,
      sourceRunId:
        item.sourceMessage?.runId && authorizedIds.has(item.sourceMessage.runId)
          ? item.sourceMessage.runId
          : undefined,
      replyToMessageId: item.sourceMessage?.replyToMessageId ?? undefined,
      messageIntent: peer?.kind === "bot_message_received" ? peer.intent : undefined,
      fromBotId: peer?.kind === "bot_message_received" ? peer.fromBotId : undefined,
      fromBotName: peer?.kind === "bot_message_received" ? peer.fromBotName : undefined,
    };
  });
  return projectExecutionPage(
    input.runId,
    events,
    afterSeq,
    input.limit,
    links,
    related.length > 50,
  );
}
