import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { isToolActivityBlock } from "./tool-activity.js";

export type MessageActivity =
  | { kind: "peer"; botId?: string; peerBotId: string; peerBotName: string; count: number }
  | { kind: "execution"; botId?: string; runId: string }
  | {
      kind: "routine";
      botId?: string;
      routineId: string;
      name: string;
      action: "created" | "updated";
    };

export type ActivityMessage = Pick<ThreadMessage, "id" | "role" | "blocks" | "runId" | "botId">;

function isPeer(block: MessageBlock) {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

/** Collapse only evidence-backed activity, keeping its original row if the reply is not loaded. */
export function projectMessageActivity<T extends ActivityMessage>(messages: readonly T[]) {
  const activities = new Map<string, MessageActivity[]>();
  const activityIndexes = new Map<string, Map<string, MessageActivity>>();
  const byId = new Map(messages.map((message) => [message.id, message]));
  const replies = new Map<string, T>();
  const scope = (message: ActivityMessage) => `${message.botId ?? ""}:${message.runId}`;
  for (const message of messages) {
    if (
      message.role === "bot" &&
      message.runId &&
      message.blocks.some(
        (block) => block.kind === "text" || (block.kind === "progress" && !block.activity),
      )
    ) {
      const previous = replies.get(scope(message));
      // A trailing progress update must not steal activity from a real reply.
      if (
        message.blocks.some((block) => block.kind === "text") ||
        !previous?.blocks.some((block) => block.kind === "text")
      ) {
        replies.set(scope(message), message);
      }
    }
  }
  const result: T[] = [];
  const resultIds = new Set<string>();
  const anchors = new Set<string>();
  for (const message of messages) {
    const blocks = message.blocks.filter(
      (block) =>
        !isPeer(block) &&
        block.kind !== "routine_change" &&
        !(message.runId && (isToolActivityBlock(block) || block.kind === "subagent")),
    );
    let ownActivity = false;
    const add = (activity: MessageActivity, source = message) => {
      const anchor = source.runId ? (replies.get(scope(source)) ?? source) : source;
      const entries = activities.get(anchor.id) ?? [];
      const index = activityIndexes.get(anchor.id) ?? new Map<string, MessageActivity>();
      activityIndexes.set(anchor.id, index);
      const key = JSON.stringify(
        activity.kind === "peer"
          ? [activity.kind, activity.botId, activity.peerBotId]
          : activity.kind === "routine"
            ? [activity.kind, activity.routineId, activity.action]
            : [activity.kind, activity.runId],
      );
      const previous = index.get(key);
      if (previous?.kind === "routine" && activity.kind === "routine") {
        previous.name = activity.name;
      } else if (previous?.kind === "peer" && activity.kind === "peer") {
        previous.count += activity.count;
        previous.peerBotName = activity.peerBotName;
      } else if (!previous) {
        entries.push(activity);
        index.set(key, activity);
      }
      activities.set(anchor.id, entries);
      anchors.add(anchor.id);
      if (anchor.id === message.id) ownActivity = true;
    };
    for (const block of message.blocks) {
      if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
        const original =
          block.kind === "bot_message_received" && block.returnToMessageId
            ? byId.get(block.returnToMessageId)
            : undefined;
        // Return receipts may refer to an earlier sender run, but never another bot's row.
        const source =
          original &&
          original.botId === message.botId &&
          block.kind === "bot_message_received" &&
          original.blocks.some(
            (candidate) =>
              candidate.kind === "bot_message_sent" && candidate.toBotId === block.fromBotId,
          )
            ? original
            : message;
        add(
          {
            kind: "peer",
            botId: message.botId,
            peerBotId: block.kind === "bot_message_sent" ? block.toBotId : block.fromBotId,
            peerBotName: block.kind === "bot_message_sent" ? block.toBotName : block.fromBotName,
            count: 1,
          },
          source,
        );
      } else if (block.kind === "routine_change") {
        add({
          kind: "routine",
          botId: message.botId,
          routineId: block.routineId,
          name: block.name,
          action: block.action,
        });
      } else if (message.runId && (isToolActivityBlock(block) || block.kind === "subagent")) {
        add({ kind: "execution", runId: message.runId, botId: message.botId });
      }
    }
    if (blocks.length || ownActivity) {
      // Unchanged rows retain identity so streaming does not invalidate every message memo.
      result.push(blocks.length === message.blocks.length ? message : { ...message, blocks });
      resultIds.add(message.id);
    }
  }
  // A later return receipt can attach to an earlier activity-only anchor.
  for (const message of messages) {
    if (anchors.has(message.id) && !resultIds.has(message.id)) {
      result.push({ ...message, blocks: [] });
      resultIds.add(message.id);
    }
  }
  const order = new Map(messages.map((message, index) => [message.id, index]));
  result.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { messages: result, activities };
}
