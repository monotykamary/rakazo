import type { AgentServiceSnapshot } from "pi-fabric/agents";
import { record } from "./pi-rpc-protocol.js";

/** The isolated worker receives only its own Pi session, never host memory/routing or sibling snapshots. */
export function workerSessionCheckpoint(value: unknown) {
  const state = record(value);
  const fields = [
    "version",
    "runtimeVersion",
    "header",
    "entries",
    "leafId",
    "sourceMessageIds",
    "modelSelection",
    "modelConfiguration",
    "kitState",
    "placement",
  ];
  return Object.fromEntries(
    fields.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]),
  );
}

/** Only trusted host persistence enters here; never accept snapshots from agents RPC. */
export function restoreAgentSnapshot(
  state: Record<string, unknown>,
  rootId: string,
): AgentServiceSnapshot | undefined {
  if (state.agents) return structuredClone(state.agents) as AgentServiceSnapshot;
  rootId = typeof state.rootParticipantId === "string" ? state.rootParticipantId : rootId;
  if (!state.participants) return undefined;
  const participants = record(state.participants);
  const depth = (id: string, seen = new Set<string>()): number => {
    if (id === state.rootParticipantId) return 0;
    if (seen.has(id)) throw new Error("Invalid legacy participant lineage");
    seen.add(id);
    const child = record(participants[id]);
    if (typeof child.parentParticipantId !== "string") throw new Error("Invalid legacy parent");
    return 1 + depth(child.parentParticipantId, seen);
  };
  const records: AgentServiceSnapshot["records"] = Object.entries(participants).map(
    ([id, value]) => {
      const child = record(value);
      if (child.participantId !== undefined && child.participantId !== id)
        throw new Error("Invalid legacy participant identity");
      if (!["running", "completed", "failed", "paused"].includes(String(child.status)))
        throw new Error("Invalid legacy participant status");
      const placement = child.placement ? record(child.placement) : undefined;
      const task =
        typeof child.task === "string" && child.task.trim() ? child.task : "Continue task";
      return {
        request: {
          task,
          recursive: true,
          ...(typeof placement?.cwd === "string" ? { cwd: placement.cwd } : {}),
        },
        record: {
          id,
          rootId,
          parentId:
            child.parentParticipantId === state.rootParticipantId
              ? rootId
              : String(child.parentParticipantId),
          depth: depth(id),
          generation: 1,
          name: String(child.name ?? "helper"),
          task,
          status:
            child.status === "completed"
              ? "completed"
              : child.status === "failed"
                ? "failed"
                : "paused",
          runner: "pi",
          kernel: "typescript",
          startedAt: 0,
          updatedAt: 0,
          turns: 0,
          toolCalls: 0,
          text: String(child.result ?? ""),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          checkpoint: { session: child.session, placement: child.placement },
        },
      };
    },
  );
  return { version: 1, rootId, starts: records.length, sequence: 0, records };
}
