import { ACTIVE_RUN_STATUSES } from "@rakazo/core";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];

export const activeRunSelection = {
  where: { status: { in: activeRunStatuses } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

export function previewFromThread(thread: {
  sessionStartedAfterSeq?: number | null;
  messages: Array<{ seq?: number; blocks: unknown }>;
}): string {
  const after = thread.sessionStartedAfterSeq;
  const visible = thread.messages.find(
    (message) => after == null || (message.seq != null && message.seq > after),
  );
  return previewFromBlocks(visible?.blocks);
}

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return "";
}
