import type {
  ExecutionInspection,
  ProductEvent,
  QueueMutation,
  QueueOperation,
  QueueReply,
  QueueSnapshot,
} from "@rakazo/contracts";

export interface QueueClient {
  list(scope: { threadId: string; botId: string }): Promise<QueueSnapshot>;
  mutate(input: QueueMutation): Promise<QueueReply>;
}
export function queueRows(snapshot: QueueSnapshot) {
  return snapshot.editing?.rows ?? snapshot.rows;
}
type ViewState = { snapshot?: QueueSnapshot; error?: string; busy: boolean };

export function createQueueStore(client: QueueClient, scope: { threadId: string; botId: string }) {
  let state: ViewState = { busy: false };
  let revision: number | undefined;
  let reading = false;
  const listeners = new Set<() => void>();
  function update(patch: Partial<ViewState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function adopt(snapshot: QueueSnapshot) {
    if (state.snapshot && snapshot.revision < state.snapshot.revision) return;
    revision = snapshot.revision;
    update({ snapshot });
  }
  async function refresh() {
    if (state.busy || reading) return;
    reading = true;
    try {
      adopt(await client.list(scope));
    } catch (cause) {
      update({ error: String(cause) });
    } finally {
      reading = false;
    }
  }
  async function mutate(operation: QueueOperation) {
    if (state.busy || revision === undefined) return false;
    update({ busy: true, error: undefined });
    try {
      const reply = await client.mutate({
        ...scope,
        requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        expectedRevision: revision,
        operation,
      });
      adopt(reply.snapshot);
      if (!reply.ok) update({ error: reply.error ?? "Queue mutation rejected" });
      return reply.ok;
    } catch (cause) {
      update({ error: String(cause) });
      // Never replay an ambiguous delivery. Reconcile before another user intent.
      revision = undefined;
      try {
        adopt(await client.list(scope));
      } catch {
        /* Polling retries the read, never delivery. */
      }
      return false;
    } finally {
      update({ busy: false });
    }
  }
  function steeringParticipants(inspection: ExecutionInspection) {
    // Inspection can include related runs in other threads. Only retained events
    // from the inspected run establish scope; graph links alone are not authority.
    const events = inspection.events.filter((event) => event.runId === inspection.runId);
    if (!events.length || events.some((event) => event.threadId !== scope.threadId)) return [];
    return inspection.participants.filter(
      (participant) =>
        participant.botId === scope.botId &&
        Boolean(participant.participantId) &&
        events.some((event) => event.botId === scope.botId),
    );
  }
  async function steer(inspection: ExecutionInspection, participantId: string, text: string) {
    if (
      !text.trim() ||
      !steeringParticipants(inspection).some((item) => item.participantId === participantId)
    )
      return false;
    return mutate({ type: "enqueue", lane: "steer", text, target: { participantId } });
  }
  return {
    refresh,
    mutate,
    steeringParticipants,
    steer,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ExecutionClient {
  inspect(input: {
    runId: string;
    afterSeq?: number;
    limit?: number;
  }): Promise<ExecutionInspection>;
}
export function createExecutionStore(client: ExecutionClient, runId: string) {
  let state: { inspection?: ExecutionInspection; busy: boolean; error?: string } = { busy: false };
  const listeners = new Set<() => void>();
  function update(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function loadMore() {
    if (state.busy) return;
    update({ busy: true, error: undefined });
    try {
      const page = await client.inspect({
        runId,
        afterSeq: state.inspection?.nextCursor,
        limit: 100,
      });
      if (page.runId !== runId) throw new Error("Execution scope mismatch");
      update({ inspection: mergeInspection(state.inspection, page) });
    } catch (cause) {
      update({ error: String(cause) });
    } finally {
      update({ busy: false });
    }
  }
  return {
    loadMore,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function participantKey(participant: ExecutionInspection["participants"][number]) {
  return JSON.stringify([participant.botId, participant.participantId ?? null]);
}
export function mergeInspection(
  previous: ExecutionInspection | undefined,
  page: ExecutionInspection,
): ExecutionInspection {
  if (!previous || previous.runId !== page.runId) return page;
  const events = new Map(previous.events.map((event) => [event.id, event]));
  for (const event of page.events) events.set(event.id, event);
  const participants = new Map(
    previous.participants.map((participant) => [participantKey(participant), participant]),
  );
  for (const participant of page.participants)
    participants.set(participantKey(participant), participant);
  function mergeEntities<
    T extends { id: string; evidence: ExecutionInspection["flow"]["nodes"][number]["evidence"] },
  >(old: T[], next: T[]): T[] {
    const entities = new Map(old.map((entity) => [entity.id, entity]));
    for (const entity of next) {
      const evidence = new Map(
        [...(entities.get(entity.id)?.evidence ?? []), ...entity.evidence].map((item) => [
          `${item.kind}:${item.id}`,
          item,
        ]),
      );
      entities.set(entity.id, {
        ...entities.get(entity.id),
        ...entity,
        evidence: [...evidence.values()],
      });
    }
    return [...entities.values()];
  }
  return {
    ...page,
    nextCursor: Math.max(previous.nextCursor, page.nextCursor),
    events: [...events.values()].sort((a, b) => a.seq - b.seq),
    participants: [...participants.values()],
    flow: {
      nodes: mergeEntities(previous.flow.nodes, page.flow.nodes),
      edges: mergeEntities(previous.flow.edges, page.flow.edges),
      hasMoreRelatedRuns: previous.flow.hasMoreRelatedRuns || page.flow.hasMoreRelatedRuns,
    },
  };
}
export function executionLabel(event: ProductEvent) {
  return [
    event.type,
    ...["toolName", "activity", "status"].flatMap((key) =>
      typeof event.payload[key] === "string" ? [event.payload[key]] : [],
    ),
  ].join(" · ");
}

export type ExecutionTraceKind =
  | "reasoning"
  | "tool"
  | "message"
  | "run"
  | "execution"
  | "activity"
  | "other";

export function executionTraceKind(type: ProductEvent["type"]): ExecutionTraceKind {
  switch (type) {
    case "thread.progress":
      return "reasoning";
    case "agent.tool.called":
      return "tool";
    case "thread.message.created":
    case "thread.message.updated":
      return "message";
    case "run.started":
    case "run.checkpointed":
    case "run.waiting_input":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return "run";
    case "agent.execution.updated":
      return "execution";
    case "runtime.activity":
      return "activity";
    default:
      return "other";
  }
}

export function executionTracePreview(payload: ProductEvent["payload"]): string | undefined {
  for (const key of ["text", "toolName", "name", "activity", "status", "summary"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function groupExecutionTrace(events: ProductEvent[]): Array<{
  kind: ExecutionTraceKind;
  events: ProductEvent[];
}> {
  const groups: Array<{ kind: ExecutionTraceKind; events: ProductEvent[] }> = [];
  for (const event of events) {
    const kind = executionTraceKind(event.type);
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && kind === "reasoning") {
      last.events.push(event);
      continue;
    }
    groups.push({ kind, events: [event] });
  }
  return groups;
}
