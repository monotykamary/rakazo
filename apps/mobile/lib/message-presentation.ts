import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

export function isCenteredAgentEvent(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "handoff" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received" ||
      block.kind === "channel_message",
  );
}

export type MessagePresentationSegment =
  | {
      kind: "content";
      blocks: MessageBlock[];
    }
  | {
      kind: "steps";
      block: Extract<MessageBlock, { kind: "steps" }>;
    };

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const segments: MessagePresentationSegment[] = [];
  let content: MessageBlock[] = [];
  const flush = () => {
    if (content.length === 0) return;
    segments.push({ kind: "content", blocks: content });
    content = [];
  };
  for (const block of blocks) {
    if (block.kind === "app_connect") continue;
    if (block.kind === "steps") {
      flush();
      segments.push({ kind: "steps", block });
      continue;
    }
    if (isToolActivityBlock(block)) continue;
    content.push(block);
  }
  flush();
  return segments;
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "steps" || !isToolActivityBlock(block));
}
