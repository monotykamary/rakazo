import { randomUUID } from "node:crypto";
import type {
  Actor,
  MessageBlock,
  QueueMutation,
  QueuePlacement,
  QueueReply,
} from "@rakazo/contracts";
import {
  blocksToAgentHistoryText,
  type DurableQueueState,
  emptyPremoveQueue,
  hydratePremoveQueue,
  premoveDrainRows,
  type QueueController,
  type QueuePorts,
  recoverPremoveQueue,
  translateQueueControl,
  updateQueueEditLog,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { authorizeQueueTarget } from "./queue-target.js";
import { assertQueuePlacementComputer, captureQueuePlacement } from "./runtime-placement.js";
import type { RuntimeSessionScope } from "./runtime-sessions.js";
import { IsolationError } from "./scope.js";

export interface PremoveQueueScope {
  spaceId: string;
  threadId: string;
  botId: string;
}
const key = (scope: PremoveQueueScope) => ({
  spaceId: scope.spaceId,
  threadId: scope.threadId,
  botId: scope.botId,
});
const where = (scope: PremoveQueueScope) => ({ spaceId_threadId_botId: key(scope) });
const json = (state: DurableQueueState) =>
  JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;

export async function assertPremoveQueueAccess(
  tx: Prisma.TransactionClient,
  actor: Actor,
  scope: PremoveQueueScope,
) {
  if (scope.spaceId !== actor.spaceId) throw new IsolationError();
  const thread = await tx.thread.findFirst({
    where: {
      id: scope.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [
        { botId: scope.botId },
        { group: { archivedAt: null, members: { some: { botId: scope.botId } } } },
      ],
    },
    select: { id: true },
  });
  const bot = await tx.bot.findFirst({
    where: { id: scope.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true },
  });
  if (!thread || !bot) throw new IsolationError();
}

async function load(
  tx: Prisma.TransactionClient,
  scope: PremoveQueueScope,
): Promise<DurableQueueState> {
  const row = await tx.premoveQueue.findUnique({ where: where(scope) });
  return row
    ? (row.state as unknown as DurableQueueState)
    : emptyPremoveQueue(`${scope.threadId}:${scope.botId}`);
}

function publicQueueSnapshot(state: DurableQueueState): QueueReply["snapshot"] {
  const attachments = (id: string) =>
    state.stagedMessages?.[id]?.blocks.flatMap((block) =>
      block.kind === "image" || block.kind === "file"
        ? [
            {
              artifactId: block.artifactId,
              name: block.name,
              mimeType: block.mimeType,
              ...(block.kind === "file" ? { size: block.size } : {}),
            },
          ]
        : [],
    ) ?? [];
  const rows = state.view.rows.map((row) => ({
    ...row,
    attachments: attachments(row.id),
    placement: state.placements?.[row.id],
    target: state.targets?.[row.id]
      ? { participantId: state.targets[row.id]!.participantId }
      : undefined,
  }));
  return {
    ...state.view,
    drain: state.drainIntent,
    rows,
    ...(state.view.editing
      ? {
          editing: {
            ...state.view.editing,
            rows: state.view.editing.rows.map((row) => ({
              ...row,
              attachments: attachments(row.id),
              placement: state.placements?.[row.id],
              target: state.targets?.[row.id]
                ? { participantId: state.targets[row.id]!.participantId }
                : undefined,
            })),
          },
        }
      : {}),
  } as QueueReply["snapshot"];
}

async function store(
  tx: Prisma.TransactionClient,
  scope: PremoveQueueScope,
  state: DurableQueueState,
) {
  await tx.premoveQueue.upsert({
    where: where(scope),
    create: { ...key(scope), revision: state.view.revision, state: json(state) },
    update: { revision: state.view.revision, state: json(state) },
  });
}

export async function listPremoveQueue(
  prisma: PrismaClient,
  actor: Actor,
  scope: PremoveQueueScope,
) {
  return prisma.$transaction(async (tx) => {
    await assertPremoveQueueAccess(tx, actor, scope);
    return publicQueueSnapshot(await load(tx, scope));
  });
}

async function adoptLegacySteering(
  tx: Prisma.TransactionClient,
  scope: PremoveQueueScope,
  state: DurableQueueState,
): Promise<{ state: DurableQueueState; ids: string[] }> {
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: scope.botId,
      claimedAt: null,
      OR: [{ runId: null }, { run: { trigger: { notIn: ["messaging", "bot_message"] } } }],
      message: {
        threadId: scope.threadId,
        NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } },
      },
    },
    include: { message: { select: { blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    take: 201,
  });
  if (!pending.length) return { state, ids: [] };
  if (pending.length > 199) throw new Error("Pending steering exceeds editable queue capacity");
  const controller = await hydratePremoveQueue(state, {
    send: async () => ({ outcome: "rejected" }),
  });
  const placement = await captureQueuePlacement(tx, scope);
  const stagedMessages = { ...state.stagedMessages };
  const placements = { ...state.placements };
  for (const item of pending) {
    const previous = new Set(controller.snapshot().rows.map((row) => row.id));
    const blocks = item.message.blocks as MessageBlock[];
    const result = await controller.request({
      version: 1,
      requestId: `adopt:${item.id}`,
      operation: {
        type: "enqueue",
        lane: "steer",
        text: blocksToAgentHistoryText(blocks) || "Attached files",
      },
    });
    if (!result.ok) throw new Error("Could not adopt legacy steering");
    const row = result.snapshot.rows.find((candidate) => !previous.has(candidate.id));
    if (!row) throw new Error("Legacy steering did not receive an identity");
    stagedMessages[row.id] = { messageId: item.messageId, blocks };
    placements[row.id] = placement;
  }
  return {
    state: {
      ...state,
      checkpoint: controller.checkpoint(),
      view: controller.snapshot(),
      stagedMessages,
      placements,
    },
    ids: pending.map((item) => item.id),
  };
}

export async function mutatePremoveQueue(
  prisma: PrismaClient,
  actor: Actor,
  input: QueueMutation,
): Promise<QueueReply> {
  const scope = { spaceId: actor.spaceId, threadId: input.threadId, botId: input.botId };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    await assertPremoveQueueAccess(tx, actor, scope);
    let state = await load(tx, scope);
    const reply = (ok: boolean, error?: string): QueueReply => ({
      version: 1,
      requestId: input.requestId,
      ok,
      ...(error ? { error } : {}),
      snapshot: publicQueueSnapshot(state),
    });
    const fingerprint = JSON.stringify({
      expectedRevision: input.expectedRevision,
      operation: input.operation,
    });
    const receipt = state.receipts.find((item) => item.requestId === input.requestId);
    if (receipt)
      return reply(
        receipt.fingerprint === fingerprint,
        receipt.fingerprint === fingerprint ? undefined : "requestId reused with different content",
      );
    if (state.view.revision !== input.expectedRevision) return reply(false, "Stale queue revision");
    if (state.owner && input.operation.type === "resume") {
      const live = await tx.run.findFirst({
        where: {
          id: state.owner.runId,
          status: "running",
          leaseOwner: state.owner.leaseOwner,
          leaseFence: state.owner.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!live) state = recoverPremoveQueue(state);
    }

    if (
      state.view.inFlight &&
      !["enqueue", "pause", "graceful-pause"].includes(input.operation.type)
    )
      return reply(false, "Dispatch in flight; mutation is locked");
    if (state.drainIntent && !["enqueue", "pause", "graceful-pause"].includes(input.operation.type))
      return reply(false, "Drain pending; mutation is locked");
    if (input.operation.type === "drain" && !premoveDrainRows(state).length)
      return reply(false, "No safe eligible queue prefix to drain");
    if (state.view.rows.length >= 200 && input.operation.type === "enqueue")
      return reply(false, "Queue is full");
    if (
      state.editOperations.length >= 1000 &&
      !["edit-save", "edit-cancel"].includes(input.operation.type)
    )
      return reply(false, "Save or cancel the current edit");
    let binding: QueuePlacement | undefined;
    let bindingPaused = false;
    if (input.operation.type === "bind-placement") {
      const id = input.operation.id;
      const row = state.view.rows.find((row) => row.id === id);
      if (!row || state.view.editing || state.placements?.[row.id]?.kind !== "unbound")
        return reply(false, "Only an unbound queued row can use the current project");
      bindingPaused = row.paused ?? false;
      binding = await captureQueuePlacement(tx, scope);
      if (binding.kind !== "project") return reply(false, "No validated project is available yet");
      const original = state.placements?.[row.id];
      if (binding.computerId !== original?.computerId || binding.homeKey !== original?.homeKey)
        return reply(false, "Queued computer changed; remove and queue again");
      const target = state.targets?.[row.id];
      if (target) {
        try {
          if (!target.placement) throw new Error("Missing participant placement");
          await authorizeQueueTarget(tx, scope, target, target.generation, target.placement);
        } catch {
          return reply(false, "Queued participant placement changed; remove and queue again");
        }
        binding = {
          ...binding,
          projectPath: target.placement.cwd,
          worktreePath: target.placement.worktreeId ?? null,
        };
      }
    }
    let target: Awaited<ReturnType<typeof authorizeQueueTarget>> | undefined;
    if (input.operation.type === "enqueue" && input.operation.target) {
      try {
        target = await authorizeQueueTarget(tx, scope, input.operation.target);
      } catch {
        return reply(false, "Participant is unavailable in this conversation");
      }
    }
    const existingQueue = await tx.premoveQueue.findUnique({ where: where(scope) });
    const beforeAdoption = state;
    const adopted = existingQueue
      ? { state, ids: [] as string[] }
      : await adoptLegacySteering(tx, scope, state);
    state = adopted.state;
    const operation =
      input.operation.type === "graceful-pause" || input.operation.type === "drain"
        ? { type: "pause" as const }
        : input.operation.type === "bind-placement"
          ? { type: "hold" as const, id: input.operation.id, paused: bindingPaused }
          : input.operation;
    const controller = await hydratePremoveQueue(state, {
      send: async () => ({ outcome: "rejected" }),
    });
    const result = await controller.request({
      version: 1,
      requestId: input.requestId,
      expectedRevision: state.view.revision,
      operation,
    });
    if (!result.ok) {
      state = beforeAdoption;
      return reply(false, result.error);
    }
    const next: DurableQueueState = {
      ...state,
      checkpoint: controller.checkpoint(),
      view: controller.snapshot(),
      editOperations: updateQueueEditLog(state, input.operation, controller.snapshot()),
      receipts: [
        ...state.receipts.filter(
          (receipt, index) => receipt.drain || index >= state.receipts.length - 199,
        ),
        {
          requestId: input.requestId,
          fingerprint,
          ...(input.operation.type === "drain" ? { drain: true } : {}),
        },
      ],
    };
    if (input.operation.type !== "resume") {
      next.view.errorHold = state.view.errorHold;
      next.view.compaction = state.view.compaction;
    }
    if (input.operation.type === "drain")
      next.drainIntent = { requestId: input.requestId, rowIds: premoveDrainRows(state) };
    else if (input.operation.type === "pause" || input.operation.type === "graceful-pause")
      next.drainIntent = undefined;
    if (input.operation.type === "bind-placement" && binding)
      next.placements = { ...state.placements, [input.operation.id]: binding };
    if (input.operation.type === "enqueue") {
      const oldIds = new Set(state.view.rows.map((row) => row.id));
      const added = next.view.rows.find((row) => !oldIds.has(row.id));
      if (added && target) next.targets = { ...state.targets, [added.id]: target };
      if (added) {
        const placement = await captureQueuePlacement(tx, scope);
        next.placements = {
          ...state.placements,
          [added.id]: target
            ? {
                ...placement,
                projectPath: target.placement.cwd,
                worktreePath: target.placement.worktreeId ?? null,
              }
            : placement,
        };
      }
    }
    if (state.view.inFlight) {
      next.view.inFlight = state.view.inFlight;
      next.view.uncertainRowIds = state.view.uncertainRowIds;
      next.checkpoint.uncertainRowIds = state.checkpoint.uncertainRowIds;
    }
    if (input.operation.type === "graceful-pause") {
      const active = await tx.run.findFirst({
        where: { ...key(scope), status: { in: ["queued", "leased", "running"] } },
        select: { id: true },
      });
      next.view.gracefulPausePending = Boolean(active);
    } else if (state.view.gracefulPausePending && input.operation.type !== "resume")
      next.view.gracefulPausePending = true;
    if (input.operation.type === "resume" && state.view.gracefulPausePending)
      return reply(false, "Graceful pause is still pending");
    // Explicit resume of a parked runtime turn records authorized durable intent. The parked-turn
    // marker stays until a newer park overwrites it, so repeated checkpoints from the old run
    // cannot undo this resume and the wake can fence against a stale checkpoint.
    if (input.operation.type === "resume" && state.view.paused && state.pausedTurn)
      next.resumeIntent = {
        requestId: input.requestId,
        userId: actor.userId,
        acceptedAt: new Date().toISOString(),
      };
    await store(tx, scope, next);
    if (adopted.ids.length)
      await tx.steeringMessage.deleteMany({ where: { id: { in: adopted.ids }, claimedAt: null } });
    await appendEventInTransaction(tx, {
      ...scope,
      type: "queue.updated",
      payload: { revision: next.view.revision },
    });
    return {
      version: 1,
      requestId: input.requestId,
      ok: true,
      snapshot: publicQueueSnapshot(next),
    };
  });
}

export async function pausePremoveQueuesInTransaction(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; threadId: string },
): Promise<void> {
  const rows = await tx.premoveQueue.findMany({ where: scope });
  for (const row of rows) {
    const state = recoverPremoveQueue(row.state as unknown as DurableQueueState);
    state.checkpoint.revision++;
    state.view.revision = state.checkpoint.revision;
    await store(tx, { ...scope, botId: row.botId }, state);
  }
}

export async function pendingPremoveMessageIds(
  prisma: PrismaClient,
  scope: PremoveQueueScope,
): Promise<string[]> {
  const row = await prisma.premoveQueue.findUnique({ where: where(scope) });
  if (!row) return [];
  const state = row.state as unknown as DurableQueueState;
  // These inputs are imported through acknowledged queue delivery, never through legacy history.
  return Object.values(state.stagedMessages ?? {}).map((item) => item.messageId);
}

/** Fixed prompt for the single continuation run of an explicitly resumed parked turn. */
export const PAUSED_TURN_CONTINUATION_PROMPT = "Continue the paused task.";

export class PremoveResumeUnavailable extends Error {
  constructor() {
    super("Paused context changed. Send a new instruction.");
    this.name = "PremoveResumeUnavailable";
  }
}

const resumeClientNonce = (sessionId: string, requestId: string) =>
  `queue-resume:${sessionId}:${requestId}`;

/** Caller holds the thread lock. Consume the accepted resume atomically; keep the parked-turn marker. */
async function consumeResumeIntent(
  tx: Prisma.TransactionClient,
  scope: PremoveQueueScope,
  state: DurableQueueState,
) {
  const checkpoint = { ...state.checkpoint, revision: state.checkpoint.revision + 1 };
  const next: DurableQueueState = {
    ...state,
    resumeIntent: undefined,
    checkpoint,
    view: { ...state.view, revision: checkpoint.revision },
  };
  await store(tx, scope, next);
  await appendEventInTransaction(tx, {
    ...scope,
    type: "queue.updated",
    payload: { revision: next.view.revision },
  });
}

/** Wake orchestration without copying the rich queue head into a native prompt. */
export async function wakePremoveQueue(
  prisma: PrismaClient,
  actor: Actor,
  scope: PremoveQueueScope,
): Promise<string | null> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    await assertPremoveQueueAccess(tx, actor, scope);
    const state = await load(tx, scope);
    const intent = state.resumeIntent;
    const continuation = Boolean(intent && state.pausedTurn && !state.view.rows.length);
    if (
      (state.view.paused && !state.drainIntent) ||
      state.view.errorHold ||
      state.view.inFlight ||
      state.view.uncertainRowIds.length ||
      state.view.gracefulPausePending ||
      state.view.rows[0]?.paused ||
      (!state.view.rows.length && !continuation)
    )
      return null;
    if (continuation) {
      const parked = state.pausedTurn!;
      const [thread, placement] = await Promise.all([
        tx.thread.findFirst({
          where: { id: scope.threadId, spaceId: scope.spaceId },
          select: { historyCompactionGeneration: true },
        }),
        captureQueuePlacement(tx, scope).catch(() => undefined),
      ]);
      const drifted =
        !parked.placement ||
        intent?.userId !== actor.userId ||
        !thread ||
        thread.historyCompactionGeneration !== parked.sessionGeneration ||
        (parked.placement &&
          (!placement ||
            placement.computerId !== parked.placement.computerId ||
            placement.homeKey !== parked.placement.homeKey ||
            placement.projectPath !== parked.placement.projectPath ||
            placement.worktreePath !== parked.placement.worktreePath));
      // Session generation or placement drifted: the parked checkpoint cannot be restored safely.
      if (drifted) {
        const held = recoverPremoveQueue(state);
        held.checkpoint.revision++;
        held.view.revision = held.checkpoint.revision;
        await store(tx, scope, held);
        return { unavailable: true };
      }
    }
    const active = await tx.run.findFirst({
      where: {
        ...key(scope),
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, status: true, taskId: true },
    });
    if (active) {
      if (!intent) return active.status === "queued" ? active.id : null;
      // Never modify a leased or running task; the terminal wake after its lease closes can
      // still hand the accepted resume to a fresh queued run.
      if (active.status !== "queued") return null;
      const task = await tx.task.findUnique({
        where: { id: active.taskId },
        select: { prompt: true },
      });
      if (!task) return null;
      // A queued run with a real user prompt supersedes continuation; a queue-only empty task
      // receives the fixed continuation prompt.
      if (task.prompt === "")
        await tx.task.update({
          where: { id: active.taskId },
          data: { prompt: PAUSED_TURN_CONTINUATION_PROMPT },
        });
      await consumeResumeIntent(tx, scope, state);
      return active.id;
    }
    const continuationNonce = intent
      ? resumeClientNonce(state.view.sessionId, intent.requestId)
      : undefined;
    if (continuationNonce) {
      const existing = await tx.run.findFirst({
        where: { spaceId: scope.spaceId, clientNonce: continuationNonce },
        select: { id: true },
      });
      if (existing) {
        await consumeResumeIntent(tx, scope, state);
        return existing.id;
      }
    }
    const task = await tx.task.create({
      data: {
        ...key(scope),
        userId: actor.userId,
        prompt: continuation ? PAUSED_TURN_CONTINUATION_PROMPT : "",
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        ...key(scope),
        taskId: task.id,
        userId: actor.userId,
        status: "queued",
        trigger: "follow_up",
        clientNonce: continuationNonce ?? `queue:${state.view.sessionId}:${state.view.revision}`,
      },
    });
    if (intent) await consumeResumeIntent(tx, scope, state);
    return run.id;
  });
  if (result && typeof result === "object") throw new PremoveResumeUnavailable();
  return result;
}

export type PremoveDispatchPorts = Omit<QueuePorts, "persist" | "send" | "command"> & {
  sendBatch?(
    rows: Parameters<PremoveDispatchPorts["send"]>[0][],
    context: Parameters<QueuePorts["send"]>[1],
  ): ReturnType<QueuePorts["send"]>;
  command?(
    row: Parameters<QueuePorts["send"]>[0] & {
      placement: QueuePlacement;
      target?: { participantId: string };
    },
    command: Parameters<NonNullable<QueuePorts["command"]>>[1],
    context: Parameters<QueuePorts["send"]>[1],
  ): ReturnType<QueuePorts["send"]>;
  validatePlacement?(placement: QueuePlacement): Promise<void>;
  send(
    row: Parameters<QueuePorts["send"]>[0] & {
      blocks?: MessageBlock[];
      placement: QueuePlacement;
      target?: { participantId: string };
    },
    context: Parameters<QueuePorts["send"]>[1],
  ): ReturnType<QueuePorts["send"]>;
};

/** Caller already holds the thread lock. No rich queue row means native steering still owns this scope. */
export async function stagePremoveSteeringInTransaction(
  tx: Prisma.TransactionClient,
  input: PremoveQueueScope & { messageId: string; blocks: MessageBlock[] },
): Promise<boolean> {
  const existing = await tx.premoveQueue.findUnique({ where: where(input) });
  if (!existing) return false;
  const state = existing.state as unknown as DurableQueueState;
  if (Object.values(state.stagedMessages ?? {}).some((item) => item.messageId === input.messageId))
    return true;
  if (state.view.rows.length >= 200) throw new Error("Queue is full");
  const controller = await hydratePremoveQueue(state, {
    send: async () => ({ outcome: "rejected" }),
  });
  const result = await controller.request({
    version: 1,
    requestId: `message:${input.messageId}`,
    operation: {
      type: "enqueue",
      lane: "steer",
      text: blocksToAgentHistoryText(input.blocks) || "Attached files",
    },
  });
  if (!result.ok) throw new Error(result.error);
  const previous = new Set(state.view.rows.map((row) => row.id));
  const row = result.snapshot.rows.find((item) => !previous.has(item.id));
  if (!row) throw new Error("Queue did not stage message");
  const next: DurableQueueState = {
    ...state,
    checkpoint: controller.checkpoint(),
    view: controller.snapshot(),
    placements: { ...state.placements, [row.id]: await captureQueuePlacement(tx, input) },
    stagedMessages: {
      ...state.stagedMessages,
      [row.id]: { messageId: input.messageId, blocks: input.blocks },
    },
  };
  if (state.view.inFlight) {
    next.view.inFlight = state.view.inFlight;
    next.view.uncertainRowIds = state.view.uncertainRowIds;
    next.checkpoint.uncertainRowIds = state.checkpoint.uncertainRowIds;
  }
  next.view.errorHold = state.view.errorHold;
  next.view.compaction = state.view.compaction;
  next.view.gracefulPausePending = state.view.gracefulPausePending;
  await store(tx, input, next);
  return true;
}

async function assertLease(tx: Prisma.TransactionClient, scope: RuntimeSessionScope) {
  const run = await tx.run.findFirst({
    where: {
      id: scope.runId,
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      botId: scope.botId,
      status: "running",
      leaseOwner: scope.leaseOwner,
      leaseFence: scope.leaseFence,
      leaseExpiresAt: { gt: new Date() },
    },
    select: { id: true, trigger: true },
  });
  if (!run) throw new Error("Queue run lease lost");
  return run;
}

export async function isPremoveGracefulPauseRequested(
  prisma: PrismaClient,
  scope: RuntimeSessionScope,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await assertLease(tx, scope);
    return (await load(tx, scope)).view.gracefulPausePending;
  });
}

/** One controller per safe-boundary call. CAS ownership prevents API/worker duplicate delivery. */
export async function dispatchPremoveQueue(
  prisma: PrismaClient,
  scope: RuntimeSessionScope,
  boundary: "idle" | "turn-end" | "agent-end" | "settled" | "paused",
  ports: PremoveDispatchPorts,
): Promise<boolean> {
  const loaded = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    const run = await assertLease(tx, scope);
    if (run.trigger === "messaging" || run.trigger === "bot_message") return null;
    const current = await load(tx, scope);
    const owner = current.owner;
    if (
      owner &&
      (owner.runId !== scope.runId ||
        owner.leaseOwner !== scope.leaseOwner ||
        owner.leaseFence !== scope.leaseFence)
    ) {
      const live = await tx.run.findFirst({
        where: {
          id: owner.runId,
          status: "running",
          leaseOwner: owner.leaseOwner,
          leaseFence: owner.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (live) throw new Error("Queue already has a live owner");
      const recovered = recoverPremoveQueue(current);
      recovered.checkpoint.revision++;
      recovered.view.revision = recovered.checkpoint.revision;
      await store(tx, scope, recovered);
      return recovered;
    }
    if (boundary === "paused") {
      // An explicit resume of this same parked turn was accepted: repeated paused checkpoints
      // from the parking run must not re-pause the queue or undo the accepted resume, both
      // before and after the accepted intent was handed to a continuation run.
      if (current.pausedTurn?.runId === scope.runId && !current.view.paused) return null;
      const held = recoverPremoveQueue(current);
      // Stamp once per parking run. Repeated paused checkpoints from the same run — including
      // ones that arrive after an explicit resume was accepted — never restamp or undo state.
      if (!current.pausedTurn || current.pausedTurn.runId !== scope.runId) {
        const [placement, thread] = await Promise.all([
          captureQueuePlacement(tx, scope).catch(() => undefined),
          tx.thread.findFirst({
            where: { id: scope.threadId, spaceId: scope.spaceId },
            select: { historyCompactionGeneration: true },
          }),
        ]);
        held.pausedTurn = {
          runId: scope.runId,
          leaseFence: scope.leaseFence,
          parkedAt: new Date().toISOString(),
          sessionGeneration: thread?.historyCompactionGeneration ?? 0,
          ...(placement
            ? {
                placement: {
                  computerId: placement.computerId,
                  homeKey: placement.homeKey,
                  projectPath: placement.projectPath,
                  worktreePath: placement.worktreePath,
                },
              }
            : {}),
        };
        // A newer park supersedes any earlier accepted resume of an older parked turn.
        held.resumeIntent = undefined;
      }
      held.checkpoint.revision++;
      held.view.revision = held.checkpoint.revision;
      await store(tx, scope, held);
      return null;
    }
    return current;
  });
  if (!loaded) return false;
  let state: DurableQueueState = loaded;
  if (state.view.inFlight) return false;
  if (state.view.gracefulPausePending) {
    if (!ports.gracefulPause) return false;
    await ports.gracefulPause();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
      await assertLease(tx, scope);
      const current = await load(tx, scope);
      current.view.gracefulPausePending = false;
      current.view.paused = true;
      current.checkpoint.revision++;
      current.view.revision = current.checkpoint.revision;
      await store(tx, scope, current);
    });
    return false;
  }
  if (state.drainIntent && boundary !== "paused")
    return dispatchPremoveDrain(prisma, scope, boundary, ports);
  if (boundary === "paused" || state.view.paused || state.view.errorHold || state.view.compaction)
    return false;
  const owner = { runId: scope.runId, leaseOwner: scope.leaseOwner, leaseFence: scope.leaseFence };
  const dispatchToken = randomUUID();
  let revision = state.view.revision;
  let writes: Promise<void> = Promise.resolve();
  let controller: QueueController;
  const flush = async () => {
    await writes;
  };
  const validatePlacement = async (rowId: string): Promise<QueuePlacement> => {
    const target = state.targets?.[rowId];
    if (target) {
      if (!target.placement) throw new Error("Queued participant placement is unavailable");
      await authorizeQueueTarget(prisma, key(scope), target, target.generation, target.placement);
    }
    const placement = state.placements?.[rowId];
    if (!placement) throw new Error("Queue row has no placement binding");
    await assertQueuePlacementComputer(prisma, scope, placement);
    if (placement.kind === "project") {
      if (!ports.validatePlacement) throw new Error("Runtime cannot validate project placement");
      await ports.validatePlacement(placement);
    }
    return placement;
  };
  controller = await hydratePremoveQueue(state, {
    ...ports,
    send: async (row, context) => {
      await flush();
      let placement: QueuePlacement;
      try {
        placement = await validatePlacement(row.id);
      } catch {
        return {
          outcome: "rejected",
          error: state.targets?.[row.id]
            ? "Queued participant placement or session changed; remove and queue again"
            : "Queued placement is unavailable; explicit binding is required",
        };
      }
      return ports.send(
        {
          ...row,
          target: state.targets?.[row.id],
          placement,
          blocks: state.stagedMessages?.[row.id]?.blocks.filter((block) => block.kind !== "text"),
        },
        context,
      );
    },
    command: async (row, command, context) => {
      await flush();
      try {
        const reviewed = translateQueueControl(command, state.targets?.[row.id]);
        if (reviewed.participantId) {
          await authorizeQueueTarget(
            prisma,
            key(scope),
            { participantId: reviewed.participantId },
            state.targets?.[row.id]?.generation,
          );
        }
      } catch (error) {
        return {
          outcome: "rejected",
          error: error instanceof Error ? error.message : "Unsupported queued control",
        };
      }
      let placement: QueuePlacement;
      try {
        placement = await validatePlacement(row.id);
      } catch {
        return {
          outcome: "rejected",
          error: state.targets?.[row.id]
            ? "Queued participant placement or session changed; remove and queue again"
            : "Queued placement is unavailable; explicit binding is required",
        };
      }
      return ports.command
        ? ports.command({ ...row, placement, target: state.targets?.[row.id] }, command, context)
        : { outcome: "rejected", error: "Command execution is unavailable" };
    },
    persist: (checkpoint) => {
      const next: DurableQueueState = {
        ...state,
        owner,
        dispatchToken,
        checkpoint,
        view: controller.snapshot(),
      };
      writes = writes.then(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
          await assertLease(tx, scope);
          const current = await load(tx, scope);
          if (current.view.revision !== revision)
            throw new Error("Queue changed during dispatch; reconcile reserved rows");
          await store(tx, scope, next);
        });
        revision = next.view.revision;
        state = next;
      });
      // Return the actual commit promise to the async headless write-ahead hook.
      void writes.catch(() => undefined);
      return writes;
    },
  });
  let eventWrites: Promise<unknown> = Promise.resolve();
  controller.subscribe((event) => {
    if (!event.ack) return;
    const ack = event.ack;
    eventWrites = eventWrites.then(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
        await assertLease(tx, scope);
        await appendEventInTransaction(tx, {
          ...scope,
          runId: scope.runId,
          type: "queue.dispatch",
          payload: {
            attemptId: ack.attemptId,
            rowId: ack.rowId,
            outcome: ack.outcome,
            revision: event.snapshot.revision,
          },
        });
      }),
    );
    void eventWrites.catch(() => undefined);
  });
  try {
    const dispatched = await controller.dispatch(boundary);
    await flush();
    await eventWrites;
    return dispatched;
  } catch (error) {
    // A concurrent enqueue/pause must survive an acknowledgment conflict. Keep exact rows uncertain.
    await prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
        await assertLease(tx, scope);
        const current = await load(tx, scope);
        if (current.dispatchToken !== dispatchToken) return;
        const recovered = recoverPremoveQueue(current);
        recovered.owner = owner;
        recovered.view.gracefulPausePending = current.view.gracefulPausePending;
        recovered.checkpoint.revision++;
        recovered.view.revision = recovered.checkpoint.revision;
        await store(tx, scope, recovered);
      })
      .catch(() => undefined);
    throw error;
  }
}

async function dispatchPremoveDrain(
  prisma: PrismaClient,
  scope: RuntimeSessionScope,
  boundary: "idle" | "turn-end" | "agent-end" | "settled",
  ports: PremoveDispatchPorts,
): Promise<boolean> {
  // Native turn boundaries accept steering without interrupting in-flight tools.
  if (boundary !== "idle" && boundary !== "settled" && boundary !== "turn-end") return false;
  if (!ports.sendBatch) return false;
  const attemptId = randomUUID();
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
    await assertLease(tx, scope);
    const state = await load(tx, scope);
    const intent = state.drainIntent;
    if (!intent || state.view.inFlight) return null;
    // The owner may have changed since dispatchPremoveQueue's preliminary read.
    if (
      state.owner &&
      (state.owner.runId !== scope.runId ||
        state.owner.leaseOwner !== scope.leaseOwner ||
        state.owner.leaseFence !== scope.leaseFence)
    )
      return null;
    const eligible = premoveDrainRows(state);
    if (!intent.rowIds.length || !intent.rowIds.every((id, index) => eligible[index] === id))
      return null;
    const rowIds = intent.rowIds;
    state.owner = {
      runId: scope.runId,
      leaseOwner: scope.leaseOwner,
      leaseFence: scope.leaseFence,
    };
    state.dispatchToken = attemptId;
    state.view.inFlight = { attemptId, rowIds };
    state.checkpoint.uncertainRowIds = [...rowIds];
    state.view.uncertainRowIds = [...rowIds];
    state.checkpoint.revision++;
    state.view.revision = state.checkpoint.revision;
    await store(tx, scope, state);
    return state;
  });
  if (!reserved) return false;
  const rowIds = reserved.view.inFlight!.rowIds;
  let result: Awaited<ReturnType<QueuePorts["send"]>>;
  try {
    const rows: Parameters<PremoveDispatchPorts["send"]>[0][] = [];
    for (const id of rowIds) {
      const row = reserved.view.rows.find((row) => row.id === id)!;
      const placement = reserved.placements![id]!;
      const target = reserved.targets?.[id];
      await assertQueuePlacementComputer(prisma, scope, placement);
      if (target)
        await authorizeQueueTarget(prisma, key(scope), target, target.generation, target.placement);
      if (placement.kind === "project") {
        if (!ports.validatePlacement) throw new Error("Runtime cannot validate project placement");
        await ports.validatePlacement(placement);
      }
      rows.push({
        ...row,
        placement,
        target,
        blocks: reserved.stagedMessages?.[id]?.blocks.filter((block) => block.kind !== "text"),
      });
    }
    // Recheck the lease after asynchronous attachment/placement authorization and before effects.
    await prisma.$transaction((tx) => assertLease(tx, scope));
    try {
      const acknowledgment = await ports.sendBatch(rows, {
        attemptId,
        boundary,
        signal: new AbortController().signal,
      });
      result =
        acknowledgment?.outcome === "accepted" || acknowledgment?.outcome === "rejected"
          ? acknowledgment
          : { outcome: "uncertain", error: "Combined prompt acceptance is uncertain" };
    } catch {
      result = { outcome: "uncertain", error: "Combined prompt acceptance is uncertain" };
    }
  } catch {
    result = { outcome: "rejected", error: "Queued placement or participant is unavailable" };
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
    await assertLease(tx, scope);
    const state = await load(tx, scope);
    if (state.dispatchToken !== attemptId || state.view.inFlight?.attemptId !== attemptId)
      throw new Error("Drain ownership changed; reserved rows require reconciliation");
    const accepted = result.outcome === "accepted";
    const uncertain = !accepted && result.outcome !== "rejected";
    if (accepted) {
      state.checkpoint.rows = state.checkpoint.rows.filter((row) => !rowIds.includes(row.id));
      state.view.rows = state.view.rows.filter((row) => !rowIds.includes(row.id));
      for (const id of rowIds) {
        delete state.placements?.[id];
        delete state.targets?.[id];
        delete state.stagedMessages?.[id];
      }
    }
    state.drainIntent = undefined;
    state.view.inFlight = undefined;
    state.view.paused = true;
    state.view.errorHold = !accepted;
    state.checkpoint.uncertainRowIds = uncertain ? rowIds : [];
    state.view.uncertainRowIds = state.checkpoint.uncertainRowIds;
    state.checkpoint.revision++;
    state.view.revision = state.checkpoint.revision;
    await store(tx, scope, state);
    for (const rowId of rowIds)
      await appendEventInTransaction(tx, {
        ...scope,
        runId: scope.runId,
        type: "queue.dispatch",
        payload: {
          attemptId,
          rowId,
          outcome: accepted ? "accepted" : uncertain ? "uncertain" : "rejected",
          revision: state.view.revision,
        },
      });
  });
  return true;
}
