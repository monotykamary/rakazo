import type { MessageBlock } from "@rakazo/contracts";
import { humanizeToolName } from "./events.js";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

const ACTIVITY_LABEL_MAX = 48;

function activityPhrase(text: string): string | undefined {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  if (trimmed.length <= ACTIVITY_LABEL_MAX) return trimmed;
  return `${trimmed.slice(0, ACTIVITY_LABEL_MAX - 1).trimEnd()}…`;
}

function labelForBlock(block: MessageBlock): string | undefined {
  if (block.kind === "steps") {
    const step = block.steps.at(-1);
    return step?.label ? activityPhrase(step.label) : undefined;
  }
  if (block.kind === "progress") {
    const tool = block.pendingToolNames?.at(-1);
    if (tool) return humanizeToolName(tool);
    return activityPhrase(block.text);
  }
  if (block.kind === "subagent") {
    return activityPhrase(block.name) ?? activityPhrase(block.task);
  }
  return undefined;
}

/** Latest live tool/progress phrase for the working glyph. */
export function liveWorkingLabel(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const live = message.id.startsWith("progress:") || message.blocks.some((block) => block.kind === "subagent");
    if (!live) continue;
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const label = labelForBlock(message.blocks[blockIndex]!);
      if (label) return label;
    }
  }
  return undefined;
}
