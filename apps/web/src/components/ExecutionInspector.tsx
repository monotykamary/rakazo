import { t } from "@lingui/core/macro";
import type { ProductEvent } from "@rakazo/contracts";
import { executionLabel, participantKey } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useExecution, type useQueue } from "../lib/use-queue";
import { ExecutionFlow } from "./ExecutionFlow";
import { WorkerModelSettings } from "./WorkerModelSettings";

const executionClient = rpc.execution;

type SteeringQueue = ReturnType<typeof useQueue>;

export function ExecutionInspector({
  runIds,
  queue,
  botId,
  threadId,
}: {
  runIds: string[];
  queue: SteeringQueue;
  botId: string;
  threadId: string;
}) {
  const [runId, setRunId] = useState(runIds[0] ?? "");
  const [flow, setFlow] = useState(false);
  const flowButtonRef = useRef<HTMLButtonElement>(null);
  const runs = [...new Set([...runIds, runId])].filter(Boolean);
  if (!runs.length) return <p className="text-muted-foreground">{t`No retained events`}</p>;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="execution-toolbar">
        {runs.length > 1 && (
          <NativeSelect
            size="default"
            aria-label={t`Run`}
            className="min-w-0 max-w-full"
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            {runs.map((id, index) => (
              <NativeSelectOption key={id} value={id}>{t`Run ${index + 1}`}</NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Button
          variant="outline"
          size="default"
          className="aria-pressed:bg-muted"
          ref={flowButtonRef}
          aria-pressed={flow}
          onClick={() => setFlow(!flow)}
        >{t`Flow`}</Button>
      </div>
      {runId && (
        <RetainedEvents
          key={runId}
          runId={runId}
          runIds={runs}
          flow={flow}
          onRun={(id) => {
            setRunId(id);
            setFlow(false);
            flowButtonRef.current?.focus();
          }}
          onShowEvents={() => {
            setFlow(false);
            flowButtonRef.current?.focus();
          }}
          queue={queue}
          botId={botId}
          threadId={threadId}
        />
      )}
    </div>
  );
}

function EventList({ events }: { events: ProductEvent[] }) {
  return (
    <ol className="space-y-2" aria-label={t`Retained events`}>
      {events.map((event) => (
        <li key={event.id} className="min-w-0 rounded border border-border p-3">
          <details>
            <summary className="cursor-pointer break-words text-sm">
              <span className="text-muted-foreground">{event.seq} · </span>
              {executionLabel(event)}
              <time className="block text-xs text-muted-foreground" dateTime={event.createdAt}>
                {event.createdAt}
              </time>
            </summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}

function RetainedEvents({
  runId,
  runIds,
  flow,
  onRun,
  onShowEvents,
  queue,
  botId,
  threadId,
}: {
  botId: string;
  threadId: string;
  runId: string;
  runIds: string[];
  flow: boolean;
  onRun: (runId: string) => void;
  onShowEvents: () => void;
  queue: SteeringQueue;
}) {
  const [evidence, setEvidence] = useState<string[]>();
  const [target, setTarget] = useState<string>();
  const [message, setMessage] = useState("");
  const { inspection, busy, error, loadMore } = useExecution(executionClient, runId);
  const participants =
    inspection?.participants.filter((participant) => participant.participantId) ?? [];
  return (
    <div aria-busy={busy} className="space-y-3">
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {inspection && participants.length > 0 && (
        <fieldset className="flex flex-wrap gap-2" aria-label={t`Participants`}>
          {participants.map((participant, index) => (
            <div className="rounded bg-muted px-2 py-1 text-xs" key={participantKey(participant)}>
              {participant.name ?? t`Participant ${index + 1}`}
              {participant.participantId && participant.botId === botId && (
                <WorkerModelSettings
                  botId={botId}
                  threadId={threadId}
                  participantId={participant.participantId}
                />
              )}
              {queue
                .steeringParticipants(inspection)
                .some((item) => participantKey(item) === participantKey(participant)) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTarget(participant.participantId);
                    setMessage("");
                  }}
                >{t`Steer participant`}</Button>
              )}
            </div>
          ))}
        </fieldset>
      )}
      {inspection &&
        target &&
        queue.steeringParticipants(inspection).some((item) => item.participantId === target) && (
          <div className="space-y-2">
            <p>
              {queue.steeringParticipants(inspection).find((item) => item.participantId === target)
                ?.name ??
                t`Participant ${participants.findIndex((item) => item.participantId === target) + 1}`}
            </p>
            <Textarea
              aria-label={t`Message to participant`}
              value={message}
              disabled={queue.busy}
              onChange={(event) => setMessage(event.target.value)}
            />
            {queue.error && (
              <p role="alert" className="text-destructive">
                {queue.error}
              </p>
            )}
            <Button
              disabled={queue.busy || !queue.snapshot || !message.trim()}
              onClick={async () => {
                if (await queue.steer(inspection, target, message)) {
                  setTarget(undefined);
                  setMessage("");
                }
              }}
            >{t`Queue message`}</Button>
            <Button
              variant="ghost"
              disabled={queue.busy}
              onClick={() => setTarget(undefined)}
            >{t`Cancel`}</Button>
          </div>
        )}
      {!flow && inspection?.events.length === 0 && (
        <p className="text-muted-foreground">{t`No retained events`}</p>
      )}
      {flow && inspection && (
        <ExecutionFlow
          flow={inspection.flow}
          rootRunId={runId}
          runIds={runIds}
          onRun={(id) => {
            setEvidence(undefined);
            onRun(id);
          }}
          onEvidence={(ids) => {
            setEvidence(ids);
            onShowEvents();
          }}
        />
      )}
      {!flow && evidence && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEvidence(undefined)}
        >{t`All events`}</Button>
      )}
      {!flow && (
        <EventList
          events={(inspection?.events ?? []).filter(
            (event) => !evidence || evidence.includes(event.id),
          )}
        />
      )}
      {!flow && evidence && !inspection?.events.some((event) => evidence.includes(event.id)) && (
        <p className="text-muted-foreground">{t`Evidence is outside the loaded events`}</p>
      )}
      <Button variant="outline" size="default" disabled={busy} onClick={() => void loadMore()}>
        {inspection?.hasMore ? t`Load more` : t`Refresh`}
      </Button>
    </div>
  );
}
