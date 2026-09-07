import { t } from "@lingui/core/macro";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { useQueue } from "../lib/use-queue";
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
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{target.view === "queue" ? t`Queue` : t`Execution`}</DialogTitle>
        </DialogHeader>
        {members.length > 1 && (
          <select
            aria-label={t`Queue for bot`}
            value={botId}
            onChange={(event) => setSelected(event.target.value)}
            className="rounded border border-border bg-background p-2 text-sm"
          >
            {members.map((member) => (
              <option key={member.botId} value={member.botId}>
                {member.name}
              </option>
            ))}
          </select>
        )}
        {botId &&
          (target.view === "queue" ? (
            <QueueStrip key={botId} threadId={threadId} botId={botId} runIds={runs} initialOpen />
          ) : (
            <ExecutionPanel key={botId} threadId={threadId} botId={botId} runIds={runs} />
          ))}
      </DialogContent>
    </Dialog>
  );
}
function ExecutionPanel({
  threadId,
  botId,
  runIds,
}: {
  threadId: string;
  botId: string;
  runIds: string[];
}) {
  const queue = useQueue(rpc.queue, threadId, botId);
  return <ExecutionInspector threadId={threadId} botId={botId} runIds={runIds} queue={queue} />;
}
