import type { ExecutionInspection, ProductEvent } from "@rakazo/contracts";
import { type ExecutionRunEvidence, projectExecutionGraph } from "./execution-graph.js";

/** A page is evidence, not an inferred execution tree. Payloads retain actual nested-call/code telemetry. */
export function projectExecutionPage(
  runId: string,
  events: ProductEvent[],
  afterSeq: number,
  limit: number,
  runs: ExecutionRunEvidence[] = [],
  hasMoreRelatedRuns = false,
): ExecutionInspection {
  const retained = events
    .filter((event) => event.runId === runId && event.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq);
  const page = retained.slice(0, limit);
  const participants: ExecutionInspection["participants"] = [
    ...new Set(page.map((event) => event.botId)),
  ].map((botId) => ({ botId }));
  const seen = new Set<string>();
  for (const event of page) {
    const participantId =
      event.type === "thread.subagent"
        ? event.payload.agentId
        : event.type === "agent.execution.updated"
          ? event.payload.participantId
          : undefined;
    if (
      typeof participantId !== "string" ||
      !participantId ||
      seen.has(`${event.botId}:${participantId}`)
    )
      continue;
    seen.add(`${event.botId}:${participantId}`);
    participants.push({
      botId: event.botId,
      participantId,
      ...(typeof event.payload.name === "string" ? { name: event.payload.name } : {}),
    });
  }
  return {
    runId,
    events: page,
    nextCursor: page.at(-1)?.seq ?? afterSeq,
    hasMore: retained.length > limit,
    participants,
    flow: projectExecutionGraph(page, runs, hasMoreRelatedRuns),
  };
}
