import { t } from "@lingui/core/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useState } from "react";
import { ExecutionInspector } from "./ExecutionInspector";
import { QueueStrip } from "./QueueStrip";

export type ThreadInspectorTarget = { view: "queue" | "execution"; botId?: string; runId?: string };

export function ThreadInspector({
  threadId,
  members,
  runIds,
  target,
  onClose,
}: {
  threadId: string;
  members: { botId: string; name: string }[];
  runIds: string[];
  target: ThreadInspectorTarget;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(target.botId ?? members[0]?.botId ?? "");
  const botId = members.some((member) => member.botId === selected) ? selected : members[0]?.botId;
  const runs = [...new Set([...(target.runId ? [target.runId] : []), ...runIds])];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(760px,calc(100%-2rem))] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-6 py-5">
          <DialogTitle className="text-xl text-foreground">
            {target.view === "queue" ? t`Queue` : t`Execution`}
          </DialogTitle>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t`Close`} />}>
            <X />
          </DialogClose>
        </DialogHeader>
        {members.length > 1 ? (
          <select
            aria-label={t`Queue for bot`}
            value={botId}
            onChange={(event) => setSelected(event.target.value)}
            className="mx-6 mt-4 rounded-lg border border-border bg-background p-2 text-sm"
          >
            {members.map((member) => (
              <option key={member.botId} value={member.botId}>
                {member.name}
              </option>
            ))}
          </select>
        ) : null}
        {botId ? (
          target.view === "queue" ? (
            <div className="rk-scroll min-h-0 flex-1 overflow-y-auto p-6">
              <QueueStrip key={botId} threadId={threadId} botId={botId} runIds={runs} initialOpen />
            </div>
          ) : (
            <ExecutionInspector key={botId} threadId={threadId} botId={botId} runIds={runs} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
