import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import { QueueStrip } from "./QueueStrip";

export function ThreadQueue({
  threadId,
  members,
  open,
  onOpenChange,
}: {
  threadId: string;
  members: { botId: string; name: string }[];
  open?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState(members[0]?.botId ?? "");
  const member = members.find((item) => item.botId === selected) ?? members[0];
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) container.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
  }, [open]);
  if (!member) return null;
  return (
    <div ref={container} data-testid="thread-queue" className="shrink-0 px-4">
      {members.length > 1 && (
        <select
          aria-label={t`Queue for bot`}
          value={member.botId}
          onChange={(event) => setSelected(event.target.value)}
          className="max-w-full rounded-md bg-background px-2 py-1 text-sm text-muted-foreground"
        >
          {members.map((item) => (
            <option key={item.botId} value={item.botId}>
              {item.name}
            </option>
          ))}
        </select>
      )}
      <QueueStrip
        key={member.botId}
        threadId={threadId}
        botId={member.botId}
        open={open}
        onOpenChange={onOpenChange}
      />
    </div>
  );
}
