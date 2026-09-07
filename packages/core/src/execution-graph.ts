import {
  type ExecutionFlow,
  type ExecutionFlowEdge,
  type ExecutionFlowNode,
  MessageBlock,
  type ProductEvent,
} from "@rakazo/contracts";

export interface ExecutionRunEvidence {
  runId: string;
  botId: string;
  status: string;
  trigger: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  replyToMessageId?: string;
  messageIntent?: string;
}
const string = (value: unknown) => (typeof value === "string" && value.length ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Relationships require persisted foreign keys or explicit retained event fields, never text matching. */
export function projectExecutionGraph(
  events: ProductEvent[],
  runs: ExecutionRunEvidence[] = [],
  hasMoreRelatedRuns = false,
): ExecutionFlow {
  const nodes = new Map<string, ExecutionFlowNode>();
  const edges = new Map<string, ExecutionFlowEdge>();
  const put = (node: ExecutionFlowNode) => {
    const prior = nodes.get(node.id);
    nodes.set(node.id, {
      ...prior,
      ...Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined)),
      id: node.id,
      kind: node.kind,
      evidence: [...(prior?.evidence ?? []), ...node.evidence].filter(
        (item, index, values) =>
          values.findIndex((other) => other.id === item.id && other.kind === item.kind) === index,
      ),
    });
    return node.id;
  };
  const link = (
    from: string,
    to: string,
    kind: ExecutionFlowEdge["kind"],
    evidence: ExecutionFlowEdge["evidence"],
  ) => {
    const id = `${kind}:${from}:${to}`;
    const prior = edges.get(id);
    edges.set(id, { id, from, to, kind, evidence: [...(prior?.evidence ?? []), ...evidence] });
  };
  for (const run of runs) {
    const evidence: ExecutionFlowNode["evidence"] = [{ kind: "run", id: run.runId }];
    const runNode = put({
      id: `run:${run.runId}`,
      kind: "run",
      runId: run.runId,
      botId: run.botId,
      status: run.status,
      evidence,
    });
    if (run.sourceMessageId) {
      const source = put({
        id: `message:${run.sourceMessageId}`,
        kind: "message",
        messageId: run.sourceMessageId,
        evidence: [{ kind: "message", id: run.sourceMessageId }],
      });
      link(source, runNode, run.trigger === "follow_up" ? "continues" : "starts", evidence);
      if (run.sourceRunId && run.sourceRunId !== run.runId) {
        const parent = put({
          id: `run:${run.sourceRunId}`,
          kind: "run",
          runId: run.sourceRunId,
          evidence: [{ kind: "message", id: run.sourceMessageId }],
        });
        link(parent, source, "contains", [{ kind: "message", id: run.sourceMessageId }]);
      }
      if (run.replyToMessageId) {
        const original = put({
          id: `message:${run.replyToMessageId}`,
          kind: "message",
          messageId: run.replyToMessageId,
          evidence: [{ kind: "message", id: run.sourceMessageId }],
        });
        link(source, original, run.messageIntent === "result" ? "results" : "replies", [
          { kind: "message", id: run.sourceMessageId },
        ]);
      }
    }
  }
  for (const event of events) {
    if (!event.runId) continue;
    const evidence: ExecutionFlowNode["evidence"] = [{ kind: "event", id: event.id }];
    const run = put({
      id: `run:${event.runId}`,
      kind: "run",
      runId: event.runId,
      botId: event.botId,
      evidence,
    });
    const data = event.payload;
    const executionId = string(data.executionId);
    if (
      (event.type === "agent.tool.called" || event.type === "agent.execution.updated") &&
      executionId
    ) {
      const execution = put({
        id: `execution:${event.runId}:${executionId}`,
        kind: "execution",
        runId: event.runId,
        executionId,
        name: string(data.name),
        status: string(data.status),
        code: string(data.code) ?? string(record(data.args).code),
        evidence,
      });
      const parentId = string(data.parentExecutionId);
      if (parentId) {
        const parent = put({
          id: `execution:${event.runId}:${parentId}`,
          kind: "execution",
          runId: event.runId,
          executionId: parentId,
          evidence,
        });
        link(parent, execution, "calls", evidence);
      } else link(run, execution, "contains", evidence);
      const participantId = string(data.participantId);
      if (participantId) {
        const participant = put({
          id: `participant:${event.runId}:${participantId}`,
          kind: "participant",
          runId: event.runId,
          participantId,
          evidence,
        });
        link(participant, execution, "contains", evidence);
      }
    }
    if (event.type === "thread.subagent") {
      const participantId = string(data.agentId);
      if (participantId) {
        const participant = put({
          id: `participant:${event.runId}:${participantId}`,
          kind: "participant",
          runId: event.runId,
          participantId,
          name: string(data.name),
          status: string(data.status),
          evidence,
        });
        link(run, participant, "delegates", evidence);
        if (typeof data.result === "string") link(participant, run, "results", evidence);
      }
    }
    if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
      const wait = put({
        id: `wait:${event.id}`,
        kind: "wait",
        runId: event.runId,
        name: event.type,
        evidence,
      });
      link(run, wait, "waits-for", evidence);
    }
    if (event.type === "runtime.activity") {
      const activity = string(data.activity);
      if (activity) {
        const recovery = put({
          id: `recovery:${event.id}`,
          kind: "recovery",
          runId: event.runId,
          name: activity,
          status: string(data.status),
          evidence,
        });
        link(run, recovery, "contains", evidence);
      }
    }
    const messageId = string(data.messageId);
    const blocks = MessageBlock.array().safeParse(data.blocks);
    if (messageId && blocks.success) {
      const message = put({
        id: `message:${messageId}`,
        kind: "message",
        runId: event.runId,
        messageId,
        evidence,
      });
      link(run, message, "contains", evidence);
      for (const block of blocks.data) {
        if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
          const botId = block.kind === "bot_message_sent" ? block.toBotId : block.fromBotId;
          const bot = put({
            id: `bot:${botId}`,
            kind: "participant",
            botId,
            name: block.kind === "bot_message_sent" ? block.toBotName : block.fromBotName,
            evidence,
          });
          link(
            block.kind === "bot_message_sent" ? message : bot,
            block.kind === "bot_message_sent" ? bot : message,
            "messages",
            evidence,
          );
          if (block.kind === "bot_message_received" && block.returnToMessageId) {
            const original = put({
              id: `message:${block.returnToMessageId}`,
              kind: "message",
              messageId: block.returnToMessageId,
              evidence,
            });
            link(message, original, block.intent === "result" ? "results" : "replies", evidence);
          }
        }
        if (block.kind === "ask" && block.status !== "answered") {
          const wait = put({
            id: `wait:${messageId}`,
            kind: "wait",
            runId: event.runId,
            messageId,
            evidence,
          });
          link(run, wait, "waits-for", evidence);
        }
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], hasMoreRelatedRuns };
}
