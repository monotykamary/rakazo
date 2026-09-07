import { t } from "@lingui/core/macro";
import type { ProductEvent } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { useExecution, type useQueue } from "../lib/use-queue";
import { ExecutionFlow } from "./ExecutionFlow";

const executionClient = rpc.execution;

import { executionLabel, participantKey } from "@rakazo/core";

type SteeringQueue = ReturnType<typeof useQueue>;

export function ExecutionInspector({ runIds, queue }: { runIds: string[]; queue: SteeringQueue }) {
  const [runId, setRunId] = useState(runIds[0] ?? "");
  const [flow, setFlow] = useState(false);
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t`Run`}
          className="min-w-0 max-w-full rounded border border-border bg-background p-2"
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
        >
          {[...new Set([...runIds, runId])].map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={flow}
          onClick={() => setFlow(!flow)}
        >{t`Flow`}</Button>
      </div>
      {runId && (
        <RetainedEvents key={runId} runId={runId} flow={flow} onRun={setRunId} queue={queue} />
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
              <span className="text-muted-foreground">
                {event.seq} · {event.botId} ·{" "}
              </span>
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
  flow,
  onRun,
  queue,
}: {
  runId: string;
  flow: boolean;
  onRun: (runId: string) => void;
  queue: SteeringQueue;
}) {
  const [evidence, setEvidence] = useState<string[]>();
  const [target, setTarget] = useState<string>();
  const [message, setMessage] = useState("");
  const { inspection, busy, error, loadMore } = useExecution(executionClient, runId);
  return (
    <div aria-busy={busy} className="space-y-3">
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {inspection && (
        <fieldset className="flex flex-wrap gap-2" aria-label={t`Participants`}>
          {inspection.participants.map((participant) => (
            <span className="rounded bg-muted px-2 py-1 text-xs" key={participantKey(participant)}>
              {participant.name ?? participant.participantId ?? participant.botId}
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
            </span>
          ))}
        </fieldset>
      )}
      {inspection &&
        target &&
        queue.steeringParticipants(inspection).some((item) => item.participantId === target) && (
          <div className="space-y-2">
            <p>
              {queue.steeringParticipants(inspection).find((item) => item.participantId === target)
                ?.name ?? target}
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
      {inspection?.events.length === 0 && (
        <p className="text-muted-foreground">{t`No retained events`}</p>
      )}
      {flow && inspection && (
        <ExecutionFlow flow={inspection.flow} onRun={onRun} onEvidence={setEvidence} />
      )}
      {evidence && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEvidence(undefined)}
        >{t`All events`}</Button>
      )}
      {(!flow || evidence) && (
        <EventList
          events={(inspection?.events ?? []).filter(
            (event) => !evidence || evidence.includes(event.id),
          )}
        />
      )}
      {evidence && !inspection?.events.some((event) => evidence.includes(event.id)) && (
        <p className="text-muted-foreground">{t`Evidence is outside the loaded events`}</p>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadMore()}>
        {inspection?.hasMore ? t`Load more` : t`Refresh`}
      </Button>
    </div>
  );
}
