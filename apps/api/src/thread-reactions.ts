import type { Actor, MessageBlock, MessageReaction } from "@rakazo/contracts";
import { messageReaction } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

/** Record feedback for the next turn, without starting a new run or losing older reactions. */
export async function appendThreadReaction(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
  input: { messageId: string; reaction: MessageReaction; clientNonce: string },
) {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true },
    });
    if (!parent) throw new IsolationError();
    const existing = await tx.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
      },
      select: { id: true },
    });
    if (existing) return { eventSeq: null };
    const botId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
    if (!botId) throw new IsolationError();
    const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: parent.id,
      clientNonce: input.clientNonce,
    });
    if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "user", blocks, replyToMessageId: parent.id },
    });
    return { eventSeq: event.seq };
  });
}

export async function removeThreadReactions(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
  input: { messageId: string; reaction?: MessageReaction },
) {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true, thumbsUp: true },
    });
    if (!parent) throw new IsolationError();
    const replies = await tx.message.findMany({
      where: { threadId: target.threadId, replyToMessageId: parent.id, role: "user" },
      select: { id: true, blocks: true },
    });
    const ids: string[] = [];
    for (const reply of replies) {
      const emoji = messageReaction({
        role: "user",
        blocks: Array.isArray(reply.blocks) ? (reply.blocks as MessageBlock[]) : [],
        replyToMessageId: parent.id,
      });
      if (!emoji) continue;
      if (input.reaction && emoji !== input.reaction) continue;
      ids.push(reply.id);
    }
    const clearThumbs = !input.reaction || input.reaction === "👍";
    if (clearThumbs && parent.thumbsUp) {
      await tx.message.update({ where: { id: parent.id }, data: { thumbsUp: false } });
    }
    if (ids.length) {
      await tx.message.deleteMany({ where: { id: { in: ids } } });
    }
    let eventSeq: number | null = null;
    const botId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
    if (!botId) throw new IsolationError();
    for (const id of ids) {
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId,
        type: "thread.message.updated",
        payload: { messageId: id, removed: true },
      });
      eventSeq = event.seq;
    }
    if (clearThumbs && parent.thumbsUp && eventSeq == null) {
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId,
        type: "thread.message.updated",
        payload: { messageId: parent.id, thumbsUp: false },
      });
      eventSeq = event.seq;
    }
    return { eventSeq };
  });
}
