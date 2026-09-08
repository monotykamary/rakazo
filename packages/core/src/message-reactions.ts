import { type MessageBlock, type MessageReaction, MessageReactionSchema } from "@rakazo/contracts";

type ReactionMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
  replyToMessageId?: string | null;
  /**
   * Legacy persisted flag stored on the target message itself. Kept additively so
   * historical reactions survive without a destructive migration; the projection
   * below folds it into the same per-target counts as new emoji replies.
   */
  thumbsUp?: boolean | null;
};

/** Emoji-only user replies are conversation messages displayed compactly beneath their target. */
export function messageReaction(
  message: Pick<ReactionMessage, "role" | "blocks" | "replyToMessageId">,
): MessageReaction | null {
  if (message.role !== "user" || !message.replyToMessageId || message.blocks.length !== 1)
    return null;
  const block = message.blocks[0];
  return block?.kind === "text" ? (MessageReactionSchema.safeParse(block.text).data ?? null) : null;
}

export function projectMessageReactions<Message extends ReactionMessage>(
  messages: readonly Message[],
) {
  const parents = new Map(messages.map((message) => [message.id, message]));
  const reactions = new Map<string, Map<MessageReaction, number>>();
  // Fold the legacy thumbs-up column into the same view so old data renders without migration.
  for (const message of messages) {
    if (message.thumbsUp === true && !messageReaction(message)) {
      const counts = reactions.get(message.id) ?? new Map<MessageReaction, number>();
      counts.set("👍", (counts.get("👍") ?? 0) + 1);
      reactions.set(message.id, counts);
    }
  }
  const visibleMessages = messages.filter((message) => {
    const emoji = messageReaction(message);
    const parentId = message.replyToMessageId;
    const parent = parentId ? parents.get(parentId) : undefined;
    // Keep an ordinary reply bubble when the parent is outside the loaded page, so it can be opened.
    if (!emoji || !parentId || !parent || messageReaction(parent) || parentId === message.id)
      return true;
    const counts = reactions.get(parentId) ?? new Map<MessageReaction, number>();
    counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    // A collapsed emoji reply can itself carry a legacy thumbs-up; keep its count on the target.
    if (message.thumbsUp === true) counts.set("👍", (counts.get("👍") ?? 0) + 1);
    reactions.set(parentId, counts);
    return false;
  });
  return { visibleMessages, reactions };
}
