import type { MessageBlock, QueueOperation, QueuePlacement } from "@rakazo/contracts";
import {
  type QueueOperation as EngineOperation,
  type QueueCheckpoint,
  QueueController,
  type QueuePorts,
  type QueueView,
} from "pi-queue-steer-factory/headless";

export interface DurableQueueState {
  checkpoint: QueueCheckpoint;
  view: QueueView;
  editOperations: Exclude<QueueOperation, { type: "bind-placement" | "drain" }>[];
  receipts: Array<{ requestId: string; fingerprint: string; drain?: boolean }>;
  placements?: Record<string, QueuePlacement>;
  targets?: Record<
    string,
    {
      participantId: string;
      generation: number;
      placement: { cwd: string; worktreeId?: string };
    }
  >;
  stagedMessages?: Record<string, { messageId?: string; blocks: MessageBlock[] }>;
  /** Resolved attachment drafts keyed by row; committed only by edit-save. */
  stagedMessageEdits?: Record<string, { blocks: MessageBlock[] }>;
  owner?: { runId: string; leaseOwner: string; leaseFence: number };
  dispatchToken?: string;
  drainIntent?: { requestId: string; rowIds: string[] };
  /** Runtime turn parked under a live lease at a pause boundary; kept until a newer park overwrites it. */
  pausedTurn?: {
    runId: string;
    leaseFence: number;
    parkedAt: string;
    sessionGeneration: number;
    placement?: {
      computerId: string | null;
      homeKey: string | null;
      projectPath: string | null;
      worktreePath: string | null;
    };
  };
  /** Explicit user resume of a parked turn; consumed atomically when handed to a queued run. */
  resumeIntent?: { requestId: string; userId: string; acceptedAt: string };
}

export function emptyPremoveQueue(sessionId: string): DurableQueueState {
  const controller = new QueueController({
    sessionId,
    ports: { send: async () => ({ outcome: "rejected" }) },
  });
  return {
    checkpoint: controller.checkpoint(),
    view: controller.snapshot(),
    editOperations: [],
    receipts: [],
  };
}

/** Hydrate a transactional continuation, not a process restart. A new run calls recover first. */
export async function hydratePremoveQueue(state: DurableQueueState, ports: QueuePorts) {
  const replay: EngineOperation[] = [];
  if (!state.view.paused && state.checkpoint.uncertainRowIds.length === 0)
    replay.push({ type: "resume" });
  replay.push(...state.editOperations);
  let hydrating = true;
  const controller = new QueueController({
    sessionId: state.checkpoint.sessionId,
    checkpoint: {
      ...state.checkpoint,
      revision: state.checkpoint.revision - replay.length,
    },
    modes: state.view.modes,
    ports: {
      ...ports,
      persist: (checkpoint) => {
        if (!hydrating) return ports.persist?.(checkpoint);
      },
    },
  });
  for (const [index, operation] of replay.entries()) {
    const result = await controller.request({
      version: 1,
      requestId: `hydrate:${index}`,
      operation,
    });
    if (!result.ok) throw new Error("Invalid durable queue edit state");
  }
  hydrating = false;
  return controller;
}

export function updateQueueEditLog(
  state: DurableQueueState,
  operation: QueueOperation,
  view: QueueView,
): DurableQueueState["editOperations"] {
  if (!view.editing) return [];
  if (operation.type === "edit-begin") return [operation];
  if (
    operation.type === "edit-select" ||
    operation.type === "edit-patch" ||
    operation.type === "reorder"
  )
    return [...state.editOperations, operation];
  return state.editOperations;
}

/** Restart drops drafts and pauses. Reserved rows already exist; never append a second copy. */
export function recoverPremoveQueue(state: DurableQueueState): DurableQueueState {
  const controller = new QueueController({
    sessionId: state.checkpoint.sessionId,
    checkpoint: state.checkpoint,
    ports: { send: async () => ({ outcome: "rejected" }) },
  });
  return {
    ...state,
    view: controller.snapshot(),
    editOperations: [],
    owner: undefined,
    drainIntent: state.checkpoint.uncertainRowIds.length ? undefined : state.drainIntent,
  };
}

export type { QueueCheckpoint, QueuePorts, QueueView };
export { QueueController };
