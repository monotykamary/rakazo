import { t } from "@lingui/core/macro";
import type { QueueSnapshot } from "@rakazo/contracts";
import { forwardRef, useEffect, useRef, useState } from "react";
import { QueueStrip, type QueueStripHandle } from "./QueueStrip";

type QueueRow = QueueSnapshot["rows"][number];

export type ThreadQueueEdit = { botId: string; row: QueueRow };
export type ThreadQueueHandle = QueueStripHandle;

export const ThreadQueue = forwardRef<
  ThreadQueueHandle,
  {
    threadId: string;
    members: { botId: string; name: string }[];
    open?: boolean;
    onOpenChange: (open: boolean) => void;
    focusBotId?: string;
    onEditChange?: (edit: ThreadQueueEdit | null) => void;
    onPopulatedChange?: (populated: boolean) => void;
    onTargetChange?: (botId: string) => void;
  }
>(function ThreadQueue(
  {
    threadId,
    members,
    open,
    onOpenChange,
    focusBotId,
    onEditChange,
    onPopulatedChange,
    onTargetChange,
  },
  ref,
) {
  const [selected, setSelected] = useState(focusBotId ?? members[0]?.botId ?? "");
  const [editing, setEditing] = useState(false);
  const member = members.find((item) => item.botId === selected) ?? members[0];
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusBotId && members.some((item) => item.botId === focusBotId)) setSelected(focusBotId);
  }, [focusBotId, members]);
  useEffect(() => {
    if (open) container.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
  }, [open]);

  if (!member) return null;
  const targetControl =
    members.length > 1 ? (
      <select
        aria-label={t`Queue for bot`}
        value={member.botId}
        disabled={editing}
        onChange={(event) => {
          setSelected(event.target.value);
          onTargetChange?.(event.target.value);
        }}
        className="max-w-28 rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {members.map((item) => (
          <option key={item.botId} value={item.botId}>
            {item.name}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div ref={container} data-testid="thread-queue" className="min-w-0">
      <QueueStrip
        ref={ref}
        key={member.botId}
        threadId={threadId}
        botId={member.botId}
        open={open}
        onOpenChange={onOpenChange}
        onPopulatedChange={onPopulatedChange}
        targetControl={targetControl}
        onEditChange={(row) => {
          setEditing(Boolean(row));
          onEditChange?.(row ? { botId: member.botId, row } : null);
        }}
      />
    </div>
  );
});
