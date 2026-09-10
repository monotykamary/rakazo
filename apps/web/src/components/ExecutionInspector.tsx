import { t } from "@lingui/core/macro";
import type { ProductEvent } from "@rakazo/contracts";
import { participantKey } from "@rakazo/core";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { useExecution } from "../lib/use-queue";
import { ExecutionFlow } from "./ExecutionFlow";
import { ExecutionTraceList } from "./ExecutionTraceList";
import { WorkerModelSettings } from "./WorkerModelSettings";

const executionClient = rpc.execution;

export function ExecutionInspector({
  runIds,
  botId,
  threadId,
}: {
  runIds: string[];
  botId: string;
  threadId: string;
}) {
  const [runId, setRunId] = useState(runIds[0] ?? "");
  const runs = [...new Set([...runIds, runId])].filter(Boolean);
  if (!runs.length) {
    return <p className="px-6 py-8 text-sm text-muted-foreground">{t`No retained events`}</p>;
  }
  return (
    <RetainedEvents
      runId={runId || runs[0]!}
      runIds={runs}
      onRun={setRunId}
      botId={botId}
      threadId={threadId}
    />
  );
}

function RetainedEvents({
  runId,
  runIds,
  onRun,
  botId,
  threadId,
}: {
  botId: string;
  threadId: string;
  runId: string;
  runIds: string[];
  onRun: (runId: string) => void;
}) {
  const [eventId, setEventId] = useState<string>();
  const [flowId, setFlowId] = useState<string>();
  const { inspection, busy, error } = useExecution(executionClient, runId);
  const participants =
    inspection?.participants.filter((participant) => participant.participantId) ?? [];
  const selectedEvent = inspection?.events.find((event) => event.id === eventId);

  return (
    <div
      aria-busy={busy}
      data-testid="execution-toolbar"
      className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[11.5rem_minmax(0,1fr)_minmax(15rem,18rem)]"
    >
      <aside className="min-h-0 min-w-0 overflow-y-auto border-b border-border md:border-e md:border-b-0">
        <nav aria-label={t`Run`} className="flex flex-col gap-0.5 p-2">
          {runIds.map((id, index) => {
            const selected = id === runId;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onRun(id);
                  setEventId(undefined);
                  setFlowId(undefined);
                }}
                className={`min-w-0 rounded-lg px-2.5 py-2 text-start text-[13px] ${
                  selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >{t`Run ${index + 1}`}</button>
            );
          })}
        </nav>
      </aside>

      <section className="min-h-0 min-w-0 overflow-y-auto px-3 py-2">
        {error ? (
          <p role="alert" className="break-words px-1 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {inspection && inspection.events.length === 0 ? (
          <p className="px-1 py-6 text-sm text-muted-foreground">{t`No retained events`}</p>
        ) : inspection ? (
          <ExecutionTraceList
            events={inspection.events}
            selectedId={eventId}
            onSelect={setEventId}
          />
        ) : null}
      </section>

      <aside className="min-h-0 min-w-0 overflow-y-auto border-t border-border md:border-s md:border-t-0">
        <div className="flex flex-col gap-2 p-3">
          {participants.length > 0 ? (
            <ul aria-label={t`Participants`} className="space-y-2">
              {participants.map((participant, index) => (
                <li key={participantKey(participant)} className="min-w-0 space-y-1">
                  <p className="truncate text-[13px]">
                    {participant.name ?? t`Participant ${index + 1}`}
                  </p>
                  {participant.participantId && participant.botId === botId ? (
                    <WorkerModelSettings
                      botId={botId}
                      threadId={threadId}
                      participantId={participant.participantId}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {inspection ? (
            <ExecutionFlow
              flow={inspection.flow}
              rootRunId={runId}
              runIds={runIds}
              selectedId={flowId}
              onSelect={setFlowId}
              onRun={(id) => {
                onRun(id);
                setEventId(undefined);
              }}
              onEvidence={(ids) => setEventId(ids[0])}
            />
          ) : null}
          <EventDetail event={selectedEvent} />
        </div>
      </aside>
    </div>
  );
}

function EventDetail({ event }: { event?: ProductEvent }) {
  if (!event) return null;
  return (
    <pre className="max-w-full min-w-0 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-muted-foreground">
      {JSON.stringify(event.payload, null, 2)}
    </pre>
  );
}
