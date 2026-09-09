import type { Actor, QueueOperation } from "@rakazo/contracts";
import type { DurableQueueState } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  dispatchPremoveQueue,
  listPremoveQueue,
  mutatePremoveQueue,
  PAUSED_TURN_CONTINUATION_PROMPT,
  type PremoveQueueMutationOptions,
  stagePremoveSteeringInTransaction,
  wakePremoveQueue,
} from "./premove-queue.js";

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
const scope = { spaceId: "space", threadId: "thread", botId: "bot" };
const lease = { ...scope, runId: "run", leaseOwner: "worker", leaseFence: 1 };
function fixture() {
  let row: { state: DurableQueueState; revision: number } | null = null;
  let chain = Promise.resolve();
  const tx = {
    $queryRaw: vi.fn(),
    steeringMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
    event: { create: vi.fn().mockResolvedValue({ id: "event", seq: 1 }) },
    runtimePlacement: { findUnique: vi.fn() },
    runtimeSession: {
      findUnique: vi.fn().mockResolvedValue({
        generation: 0,
        state: {
          rootParticipantId: "old-run",
          participants: {
            child: {
              participantId: "child",
              parentParticipantId: "old-run",
              placement: {
                cwd: "projects/child",
                worktreeId: "worktrees/child",
              },
            },
          },
        },
      }),
    },
    thread: {
      update: vi.fn(async ({ data }) =>
        data.nextMessageSeq ? { nextMessageSeq: 1 } : { nextEventSeq: 1 },
      ),
      findFirst: vi.fn(async ({ where }) =>
        (where.userId === undefined || where.userId === actor.userId) &&
        where.spaceId === actor.spaceId
          ? { id: "thread", historyCompactionGeneration: 0 }
          : null,
      ),
    },
    message: { create: vi.fn().mockResolvedValue({ id: "delivered-message" }) },
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }): Promise<unknown> =>
          (where.userId === undefined || where.userId === actor.userId) &&
          where.spaceId === actor.spaceId
            ? { id: "bot" }
            : null,
      ),
    },
    run: {
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "new-run" }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }): Promise<unknown> =>
          where.id === "run" && where.leaseOwner === "worker" && where.leaseFence === 1
            ? { id: "run", trigger: "user" }
            : null,
      ),
    },
    task: {
      create: vi.fn().mockResolvedValue({ id: "new-task" }),
      findUnique: vi.fn().mockResolvedValue({ prompt: "" }),
      update: vi.fn().mockResolvedValue({}),
    },
    premoveQueue: {
      findUnique: vi.fn(async () => structuredClone(row)),
      upsert: vi.fn(async ({ create, update }) => {
        row = structuredClone(row ? { ...row, ...update } : create);
        return row;
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (value: typeof tx) => Promise<unknown>) => {
      const work = chain.then(async () => {
        const previous = structuredClone(row);
        try {
          return await fn(tx);
        } catch (error) {
          row = previous;
          throw error;
        }
      });
      chain = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  } as unknown as PrismaClient;
  let request = 0;
  const mutate = async (operation: QueueOperation, options?: PremoveQueueMutationOptions) => {
    const current = await listPremoveQueue(prisma, actor, scope);
    const result = await mutatePremoveQueue(
      prisma,
      actor,
      {
        ...scope,
        expectedRevision: current.revision,
        requestId: `request:${++request}`,
        operation,
      },
      options,
    );
    expect(result.ok).toBe(true);
    return result.snapshot;
  };
  return { prisma, tx, mutate, state: () => structuredClone(row?.state) };
}

describe("durable premove database service", () => {
  it.each(["idle", "settled", "turn-end"] as const)(
    "drains a paused cross-lane prefix once at %s with write-ahead reservation and concurrent enqueue",
    async (boundary) => {
      const f = fixture();
      await f.mutate({
        type: "enqueue",
        lane: "steer",
        text: "first",
        images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
      });
      await f.mutate({ type: "enqueue", lane: "followUp", text: "second" });
      await f.mutate({ type: "enqueue", lane: "steer", text: "/compact" });
      const revision = f.state()!.view.revision;
      const request = {
        ...scope,
        requestId: "drain-once",
        expectedRevision: revision,
        operation: { type: "drain" as const },
      };
      expect((await mutatePremoveQueue(f.prisma, actor, request)).ok).toBe(true);
      expect(await wakePremoveQueue(f.prisma, actor, scope)).toBe("new-run");
      const send = vi.fn();
      const sendBatch = vi.fn(async (rows) => {
        expect(rows.map((row: { text: string }) => row.text)).toEqual(["first", "second"]);
        expect(rows[0].images).toHaveLength(1);
        expect(f.state()!.checkpoint.uncertainRowIds).toEqual(
          rows.map((row: { id: string }) => row.id),
        );
        expect(f.state()!.view.inFlight?.rowIds).toHaveLength(2);
        await f.mutate({ type: "enqueue", lane: "steer", text: "later" });
        return { outcome: "accepted" as const };
      });
      expect(
        await dispatchPremoveQueue(f.prisma, lease, "agent-end", {
          send,
          sendBatch,
        }),
      ).toBe(false);
      await Promise.all([
        dispatchPremoveQueue(f.prisma, lease, boundary, { send, sendBatch }),
        dispatchPremoveQueue(f.prisma, lease, boundary, { send, sendBatch }),
      ]);
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(f.state()!.view.rows.map((row) => row.text)).toEqual(["/compact", "later"]);
      expect(f.state()!.view.paused).toBe(true);
      expect(f.state()!.view.uncertainRowIds).toEqual([]);
      expect(
        f.tx.event.create.mock.calls.filter(([arg]) => arg.data.type === "queue.dispatch"),
      ).toHaveLength(2);
      expect((await mutatePremoveQueue(f.prisma, actor, request)).ok).toBe(true);
      expect(f.state()!.drainIntent).toBeUndefined();
      expect(
        (
          await mutatePremoveQueue(f.prisma, actor, {
            ...request,
            expectedRevision: revision + 1,
          })
        ).ok,
      ).toBe(false);
    },
  );

  it("does not skip held/control heads or accept a drain during editing", async () => {
    for (const head of [
      { text: "held", paused: true },
      { text: "/compact" },
      { text: "editing" },
    ]) {
      const f = fixture();
      const snapshot = await f.mutate({
        type: "enqueue",
        lane: "steer",
        ...head,
      });
      await f.mutate({ type: "enqueue", lane: "followUp", text: "tail" });
      if (head.text === "editing") await f.mutate({ type: "edit-begin", id: snapshot.rows[0]!.id });
      const reply = await mutatePremoveQueue(f.prisma, actor, {
        ...scope,
        requestId: "blocked",
        expectedRevision: f.state()!.view.revision,
        operation: { type: "drain" },
      });
      expect(reply.ok).toBe(false);
      expect(f.state()!.view.rows).toHaveLength(2);
    }
  });

  it("locks captured rows, permits canceling pending drain, and never sends without a batch port", async () => {
    const f = fixture();
    const snapshot = await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "first",
    });
    await f.mutate({ type: "drain" });
    const blocked = await mutatePremoveQueue(f.prisma, actor, {
      ...scope,
      requestId: "edit",
      expectedRevision: f.state()!.view.revision,
      operation: { type: "remove", id: snapshot.rows[0]!.id },
    });
    expect(blocked.ok).toBe(false);
    const send = vi.fn();
    expect(await dispatchPremoveQueue(f.prisma, lease, "idle", { send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await f.mutate({ type: "pause" });
    expect(f.state()!.drainIntent).toBeUndefined();
    expect(f.state()!.view.rows).toHaveLength(1);
  });

  it.each(["rejected", "uncertain", "throw", "missing", "invalid"])(
    "preserves every row on %s batch outcome",
    async (outcome) => {
      const f = fixture();
      await f.mutate({ type: "enqueue", lane: "steer", text: "first" });
      await f.mutate({ type: "enqueue", lane: "followUp", text: "second" });
      await f.mutate({ type: "drain" });
      const sendBatch = vi.fn(async () => {
        if (outcome === "throw") throw new Error("disconnected");
        if (outcome === "missing") return undefined as never;
        return { outcome: outcome as "rejected" | "uncertain" };
      });
      await dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      });
      expect(f.state()!.view.rows.map((row) => row.text)).toEqual(["first", "second"]);
      expect(f.state()!.view.uncertainRowIds).toHaveLength(outcome === "rejected" ? 0 : 2);
      expect(f.state()!.view.errorHold).toBe(true);
      expect(f.state()!.drainIntent).toBeUndefined();
      await dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      });
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(
        (
          await mutatePremoveQueue(f.prisma, actor, {
            ...scope,
            requestId: "retry",
            expectedRevision: f.state()!.view.revision,
            operation: { type: "drain" },
          })
        ).ok,
      ).toBe(false);
    },
  );

  it("does not reserve a drain if ownership changes after the preliminary read", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "first" });
    await f.mutate({ type: "drain" });
    const state = f.state()!;
    f.tx.premoveQueue.findUnique
      .mockResolvedValueOnce({ state, revision: state.view.revision })
      .mockResolvedValueOnce({
        state: {
          ...state,
          owner: { runId: "other", leaseOwner: "other-worker", leaseFence: 2 },
        },
        revision: state.view.revision,
      });
    const sendBatch = vi.fn();
    expect(
      await dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      }),
    ).toBe(false);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(f.state()!.checkpoint.uncertainRowIds).toEqual([]);
    expect(f.state()!.view.rows).toHaveLength(1);
  });

  it("staging a message cannot clear a failed drain's safety hold", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "first" });
    await f.mutate({ type: "drain" });
    await dispatchPremoveQueue(f.prisma, lease, "idle", {
      send: vi.fn(),
      sendBatch: async () => ({ outcome: "uncertain" }),
    });
    const before = f.state()!;
    await f.prisma.$transaction((tx) =>
      stagePremoveSteeringInTransaction(tx, {
        ...scope,
        messageId: "later",
        blocks: [{ kind: "text", text: "later" }],
      }),
    );
    expect(f.state()!.view.errorHold).toBe(true);
    expect(f.state()!.checkpoint.uncertainRowIds).toEqual(before.checkpoint.uncertainRowIds);
    expect(f.state()!.view.rows.map((row) => row.text)).toEqual(["first", "later"]);
    expect(await wakePremoveQueue(f.prisma, actor, scope)).toBeNull();
  });

  it("never sends before reservation persistence and preserves rows on acknowledgment rollback", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "first" });
    await f.mutate({ type: "drain" });
    const sendBatch = vi.fn(async () => ({ outcome: "accepted" as const }));
    f.tx.premoveQueue.upsert.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      }),
    ).rejects.toThrow("write failed");
    expect(sendBatch).not.toHaveBeenCalled();
    f.tx.event.create.mockRejectedValueOnce(new Error("ack failed"));
    await expect(
      dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      }),
    ).rejects.toThrow("ack failed");
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(f.state()!.view.rows).toHaveLength(1);
    expect(f.state()!.checkpoint.uncertainRowIds).toHaveLength(1);
    expect(
      await dispatchPremoveQueue(f.prisma, lease, "idle", {
        send: vi.fn(),
        sendBatch,
      }),
    ).toBe(false);
  });

  it("captures the child project rather than root and rejects later child drift", async () => {
    const f = fixture();
    const bot = { id: "bot", computer: { id: "computer", homeKey: "home" } };
    f.tx.bot.findFirst.mockResolvedValue(bot);
    f.tx.runtimePlacement.findUnique.mockResolvedValue({
      computerId: "computer",
      homeKey: "home",
      projectPath: "projects/root",
      worktreePath: null,
      revision: 1,
    });
    const queued = await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "help",
      target: { participantId: "child" },
    });
    expect(queued.rows[0]!.placement).toMatchObject({
      computerId: "computer",
      homeKey: "home",
      kind: "project",
      projectPath: "projects/child",
      worktreePath: "worktrees/child",
    });
    await f.mutate({ type: "resume" });
    const retained = await f.tx.runtimeSession.findUnique();
    retained.state.participants.child.placement.cwd = "projects/moved";
    const send = vi.fn();
    const validatePlacement = vi.fn();
    await dispatchPremoveQueue(f.prisma, lease, "turn-end", {
      send,
      validatePlacement,
    });
    expect(send).not.toHaveBeenCalled();
    expect(validatePlacement).not.toHaveBeenCalled();
    expect(f.state()!.view.rows).toHaveLength(1);
    expect(f.state()!.view.paused).toBe(true);
  });

  it("retains targeted ownership across edits and product run changes", async () => {
    const f = fixture();
    const snapshot = await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "help",
      target: { participantId: "child" },
    });
    const id = snapshot.rows[0]!.id;
    expect(snapshot.rows[0]!.target).toEqual({ participantId: "child" });
    await f.mutate({ type: "edit-begin", id });
    await f.mutate({ type: "edit-patch", patch: { text: "updated" } });
    await f.mutate({ type: "edit-save" });
    await f.mutate({ type: "resume" });
    const send = vi.fn(async (row) => {
      expect(row.target).toMatchObject({ participantId: "child" });
      expect(row.text).toBe("updated");
      expect(f.state()!.view.inFlight?.rowIds).toEqual([id]);
      return { outcome: "accepted" as const };
    });
    await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send });
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects unknown targets and invalidated retained sessions", async () => {
    const f = fixture();
    const rejected = await mutatePremoveQueue(f.prisma, actor, {
      ...scope,
      requestId: "bad-target",
      expectedRevision: 0,
      operation: {
        type: "enqueue",
        lane: "steer",
        text: "bad",
        target: { participantId: "foreign" },
      },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.snapshot.rows).toEqual([]);
    await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "help",
      target: { participantId: "child" },
    });
    await f.mutate({ type: "resume" });
    f.tx.runtimeSession.findUnique.mockResolvedValueOnce(null);
    const send = vi.fn();
    await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send });
    expect(send).not.toHaveBeenCalled();
    expect(f.state()!.view.rows).toHaveLength(1);
    expect(f.state()!.view.paused).toBe(true);
  });
  it("checks scope ownership and rejects stale revisions without mutating", async () => {
    const f = fixture();
    await expect(
      listPremoveQueue(f.prisma, { ...actor, userId: "other" }, scope),
    ).rejects.toThrow();
    await f.mutate({ type: "enqueue", lane: "steer", text: "first" });
    const request = {
      ...scope,
      requestId: "stale",
      expectedRevision: 0,
      operation: { type: "pause" as const },
    };
    expect(await mutatePremoveQueue(f.prisma, actor, request)).toMatchObject({
      ok: false,
      error: "Stale queue revision",
    });
    expect(f.state()!.view.rows).toHaveLength(1);
  });

  it("adopts old unclaimed steering before new intent without keeping a second queue", async () => {
    const f = fixture();
    f.tx.steeringMessage.findMany.mockResolvedValueOnce([
      {
        id: "native",
        messageId: "message",
        message: { seq: 1, blocks: [{ kind: "text", text: "older" }] },
      },
    ]);
    const snapshot = await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "newer",
    });
    expect(snapshot.rows.map((row) => row.text)).toEqual(["older", "newer"]);
    expect(f.tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["native"] }, claimedAt: null },
    });
  });

  it("does not deliver private premoves into a messaging run", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "private" });
    await f.mutate({ type: "resume" });
    f.tx.run.findFirst.mockResolvedValue({ id: "run", trigger: "messaging" });
    const send = vi.fn();
    expect(await dispatchPremoveQueue(f.prisma, lease, "idle", { send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(f.state()!.view.rows).toHaveLength(1);
  });

  it("persists request idempotence across controller instances", async () => {
    const f = fixture();
    const input = {
      ...scope,
      requestId: "same",
      expectedRevision: 0,
      operation: {
        type: "enqueue" as const,
        lane: "steer" as const,
        text: "one",
      },
    };
    expect((await mutatePremoveQueue(f.prisma, actor, input)).ok).toBe(true);
    expect((await mutatePremoveQueue(f.prisma, actor, input)).ok).toBe(true);
    expect(
      (
        await mutatePremoveQueue(f.prisma, actor, {
          ...input,
          operation: { ...input.operation, text: "different" },
        })
      ).ok,
    ).toBe(false);
    expect(f.state()!.view.rows).toHaveLength(1);
  });

  it("commits the reservation before transport and final acknowledgment before return", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "one" });
    await f.mutate({ type: "resume" });
    const send = vi.fn(async (row) => {
      expect(f.state()!.checkpoint.uncertainRowIds).toEqual([row.id]);
      expect(f.state()!.view.inFlight?.rowIds).toEqual([row.id]);
      return { outcome: "accepted" as const };
    });
    expect(await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.state()!.view.rows).toEqual([]);
    expect(f.state()!.view.inFlight).toBeUndefined();
  });

  it("never invokes runtime for unsupported controls or foreign gates", async () => {
    for (const text of [
      "/reload",
      "/new",
      "/model other",
      "/thinking high",
      "/fabric prewalk",
      "/fabric await foreign",
      "/fabric await",
    ]) {
      const f = fixture();
      await f.mutate({ type: "enqueue", lane: "steer", text });
      await f.mutate({ type: "resume" });
      const send = vi.fn();
      const command = vi.fn();
      await dispatchPremoveQueue(f.prisma, lease, "idle", { send, command });
      expect(command).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(f.state()!.view.rows).toHaveLength(1);
      expect(f.state()!.view.paused).toBe(true);
    }
  });

  it("requires command completion, not transport acceptance", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "/compact" });
    await f.mutate({ type: "resume" });
    const send = vi.fn();
    const command = vi.fn(async () => ({ outcome: "accepted" as const }));
    await dispatchPremoveQueue(f.prisma, lease, "idle", { send, command });
    expect(command).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(f.state()!.checkpoint.uncertainRowIds).toHaveLength(1);
    expect(f.state()!.view.rows).toHaveLength(1);
    expect(f.state()!.view.paused).toBe(true);
  });

  it("removes reviewed commands only after durable completion", async () => {
    const f = fixture();
    const snapshot = await f.mutate({
      type: "enqueue",
      lane: "steer",
      text: "/compact",
    });
    await f.mutate({ type: "resume" });
    const command = vi.fn(async (row, command) => {
      expect(command).toEqual({ kind: "compact" });
      expect(f.state()!.view.inFlight?.rowIds).toEqual([row.id]);
      expect(row.id).toBe(snapshot.rows[0]!.id);
      return { outcome: "completed" as const };
    });
    await dispatchPremoveQueue(f.prisma, lease, "idle", {
      send: vi.fn(),
      command,
    });
    expect(command).toHaveBeenCalledOnce();
    expect(f.state()!.view.rows).toEqual([]);
  });

  it("prevents two simultaneous boundary owners from sending twice", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "one" });
    await f.mutate({ type: "resume" });
    const send = vi.fn(async () => ({ outcome: "accepted" as const }));
    await Promise.allSettled([
      dispatchPremoveQueue(f.prisma, lease, "turn-end", { send }),
      dispatchPremoveQueue(f.prisma, lease, "turn-end", { send }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains concurrent enqueue and uncertain rows after acknowledgment conflict", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "one" });
    await f.mutate({ type: "resume" });
    await expect(
      dispatchPremoveQueue(f.prisma, lease, "turn-end", {
        send: async () => {
          await f.mutate({ type: "enqueue", lane: "followUp", text: "two" });
          return { outcome: "accepted" };
        },
      }),
    ).rejects.toThrow();
    expect(f.state()!.view.rows.map((row) => row.text)).toEqual(["one", "two"]);
    expect(f.state()!.view.paused).toBe(true);
    expect(f.state()!.view.inFlight).toBeUndefined();
    expect(f.state()!.checkpoint.uncertainRowIds).toHaveLength(1);
  });

  it("records confirmed graceful pause without pausing twice or delivering anything", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "one" });
    f.tx.run.findFirst.mockResolvedValue({ id: "run", trigger: "user" });
    await f.mutate({ type: "graceful-pause" });
    expect(f.state()!.view.gracefulPausePending).toBe(true);
    const send = vi.fn();
    const gracefulPause = vi.fn().mockResolvedValue(undefined);
    await dispatchPremoveQueue(f.prisma, lease, "paused", {
      send,
      gracefulPause,
    });
    expect(gracefulPause).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(f.state()!.view).toMatchObject({
      paused: true,
      gracefulPausePending: false,
    });
  });

  it("does not strand an idle queue waiting for a nonexistent runtime pause", async () => {
    const f = fixture();
    const paused = await f.mutate({ type: "graceful-pause" });
    expect(paused).toMatchObject({ paused: true, gracefulPausePending: false });
    expect((await f.mutate({ type: "resume" })).paused).toBe(false);
  });

  // Parks the live run at a pause boundary, stamps one paused turn, then records an explicit
  // resume intent and restores the lease-only run lookup for wake assertions.
  async function parkedAndResumed(f: ReturnType<typeof fixture>, requestId = "resume-1") {
    f.tx.run.findFirst.mockResolvedValue({ id: "run", trigger: "user" });
    await f.mutate({ type: "graceful-pause" });
    const send = vi.fn(async () => ({ outcome: "accepted" as const }));
    await dispatchPremoveQueue(f.prisma, lease, "paused", {
      send,
      gracefulPause: vi.fn().mockResolvedValue(undefined),
    });
    await dispatchPremoveQueue(f.prisma, lease, "paused", { send });
    const parked = f.state()!;
    expect(parked.view.paused).toBe(true);
    expect(parked.pausedTurn).toMatchObject({
      runId: "run",
      leaseFence: 1,
      sessionGeneration: 0,
    });
    expect(parked.resumeIntent).toBeUndefined();
    const current = await listPremoveQueue(f.prisma, actor, scope);
    const input = {
      ...scope,
      requestId,
      expectedRevision: current.revision,
      operation: { type: "resume" as const },
    };
    expect((await mutatePremoveQueue(f.prisma, actor, input)).ok).toBe(true);
    f.tx.run.findFirst.mockImplementation(
      async ({ where }: { where: { id?: string; leaseOwner?: string; leaseFence?: number } }) =>
        where.id === "run" && where.leaseOwner === "worker" && where.leaseFence === 1
          ? { id: "run", trigger: "user" }
          : null,
    );
    return input;
  }

  it("stamps one paused turn, preserves an accepted resume across repeated checkpoints and wakes exactly one continuation", async () => {
    const f = fixture();
    const input = await parkedAndResumed(f);
    const state = () => f.state()!;
    expect(state()!.resumeIntent).toMatchObject({ requestId: "resume-1" });
    expect(state()!.view.paused).toBe(false);
    // Repeated paused checkpoints from the parking run neither re-stamp, re-pause, nor undo the resume.
    await dispatchPremoveQueue(f.prisma, lease, "paused", { send: vi.fn() });
    expect(state()!.pausedTurn!.runId).toBe("run");
    expect(state()!.resumeIntent).toMatchObject({ requestId: "resume-1" });
    expect(state()!.view.paused).toBe(false);
    // Empty rows plus the accepted resume wake exactly one fenced continuation run.
    expect(await wakePremoveQueue(f.prisma, actor, scope)).toBe("new-run");
    expect(f.tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prompt: PAUSED_TURN_CONTINUATION_PROMPT,
      }),
    });
    expect(f.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "follow_up",
        clientNonce: `queue-resume:thread:bot:${input.requestId}`,
      }),
    });
    expect(state()!.resumeIntent).toBeUndefined();
    expect(state()!.pausedTurn).toMatchObject({ runId: "run" });
    // Idempotent: consumed intent wakes nothing new.
    expect(await wakePremoveQueue(f.prisma, actor, scope)).toBeNull();
    expect(f.tx.run.create).toHaveBeenCalledTimes(1);
  });

  it("hands an accepted resume to an existing queued run and never modifies a running task", async () => {
    const f = fixture();
    await parkedAndResumed(f);
    f.tx.run.findFirst.mockResolvedValue({
      id: "queued-run",
      status: "queued",
      taskId: "queued-task",
    });
    f.tx.task.findUnique.mockResolvedValue({ prompt: "" });
    expect(await wakePremoveQueue(f.prisma, actor, scope)).toBe("queued-run");
    expect(f.tx.task.update).toHaveBeenCalledWith({
      where: { id: "queued-task" },
      data: { prompt: PAUSED_TURN_CONTINUATION_PROMPT },
    });
    expect(f.state()!.resumeIntent).toBeUndefined();

    const superseded = fixture();
    await parkedAndResumed(superseded, "resume-2");
    superseded.tx.run.findFirst.mockResolvedValue({
      id: "queued-run",
      status: "queued",
      taskId: "queued-task",
    });
    superseded.tx.task.findUnique.mockResolvedValue({
      prompt: "real user prompt",
    });
    expect(await wakePremoveQueue(superseded.prisma, actor, scope)).toBe("queued-run");
    expect(superseded.tx.task.update).not.toHaveBeenCalled();
    expect(superseded.state()!.resumeIntent).toBeUndefined();

    const running = fixture();
    await parkedAndResumed(running, "resume-3");
    running.tx.run.findFirst.mockResolvedValue({
      id: "active-run",
      status: "running",
      taskId: "active-task",
    });
    expect(await wakePremoveQueue(running.prisma, actor, scope)).toBeNull();
    expect(running.tx.task.update).not.toHaveBeenCalled();
    expect(running.state()!.resumeIntent).toMatchObject({
      requestId: "resume-3",
    });
  });

  it("fails closed without a wake when session generation or placement drifted from the parked turn", async () => {
    const generation = fixture();
    await parkedAndResumed(generation);
    generation.tx.thread.findFirst.mockResolvedValue({
      id: "thread",
      historyCompactionGeneration: 7,
    });
    await expect(wakePremoveQueue(generation.prisma, actor, scope)).rejects.toThrow(
      "Paused context changed",
    );
    expect(generation.tx.run.create).not.toHaveBeenCalled();
    expect(generation.state()!.resumeIntent).toBeDefined();
    expect(generation.state()!.view.paused).toBe(true);

    const placement = fixture();
    await parkedAndResumed(placement);
    placement.tx.bot.findFirst.mockResolvedValue({
      id: "bot",
      computer: { id: "computer-2", homeKey: "home-2" },
    });
    await expect(wakePremoveQueue(placement.prisma, actor, scope)).rejects.toThrow(
      "Paused context changed",
    );
    expect(placement.tx.run.create).not.toHaveBeenCalled();
    expect(placement.state()!.resumeIntent).toBeDefined();
    expect(placement.state()!.view.paused).toBe(true);
  });

  it.each(["placement", "principal"] as const)(
    "holds continuation when its saved %s is unavailable",
    async (field) => {
      const f = fixture();
      await parkedAndResumed(f);
      const altered = f.state()!;
      if (field === "placement") delete altered.pausedTurn!.placement;
      else altered.resumeIntent!.userId = "another-user";
      await f.tx.premoveQueue.upsert({
        create: { state: altered },
        update: { state: altered },
      });
      await expect(wakePremoveQueue(f.prisma, actor, scope)).rejects.toThrow(
        "Paused context changed",
      );
      expect(f.tx.run.create).not.toHaveBeenCalled();
      expect(f.state()!.resumeIntent).toBeDefined();
      expect(f.state()!.view.paused).toBe(true);
    },
  );

  it("rejects transport when reservation persistence fails", async () => {
    const f = fixture();
    await f.mutate({ type: "enqueue", lane: "steer", text: "one" });
    await f.mutate({ type: "resume" });
    f.tx.premoveQueue.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    const send = vi.fn(async () => ({ outcome: "accepted" as const }));
    await expect(dispatchPremoveQueue(f.prisma, lease, "turn-end", { send })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers explicit steer and follow-up composer rows only at their FIFO boundaries", async () => {
    const f = fixture();
    await f.mutate(
      { type: "enqueue", lane: "steer", text: "steer now" },
      { stageComposerMessage: true },
    );
    await f.mutate(
      { type: "enqueue", lane: "followUp", text: "after settling" },
      { stageComposerMessage: true },
    );
    await f.mutate({ type: "resume" });
    const send = vi.fn(async (_row: { text: string }) => ({ outcome: "accepted" as const }));
    expect(f.tx.message.create).not.toHaveBeenCalled();

    expect(await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send })).toBe(true);
    expect(send.mock.calls.map(([row]) => row.text)).toEqual(["steer now"]);
    expect(f.tx.message.create).toHaveBeenCalledTimes(1);
    expect(await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    expect(await dispatchPremoveQueue(f.prisma, lease, "settled", { send })).toBe(true);
    expect(send.mock.calls.map(([row]) => row.text)).toEqual(["steer now", "after settling"]);
    expect(f.tx.message.create).toHaveBeenCalledTimes(2);
    expect(f.state()!.view.rows).toEqual([]);
  });

  it("authorizes composer artifacts before mutation and leaves no queue state on failure", async () => {
    const f = fixture();
    const resolveAttachments = vi.fn().mockRejectedValue(new Error("foreign artifact"));
    await expect(
      f.mutate(
        {
          type: "enqueue",
          lane: "steer",
          text: "private",
          artifactIds: ["foreign"],
        },
        { stageComposerMessage: true, resolveAttachments },
      ),
    ).rejects.toThrow("foreign artifact");
    expect(f.state()).toBeUndefined();
    expect(f.tx.premoveQueue.upsert).not.toHaveBeenCalled();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  });

  it("keeps resolved attachments through drafts and publishes only the delivered edit", async () => {
    const f = fixture();
    const resolveAttachments: NonNullable<PremoveQueueMutationOptions["resolveAttachments"]> =
      vi.fn(async (_tx, artifactIds: string[]) =>
        artifactIds.map((artifactId) => ({
          kind: "file" as const,
          artifactId,
          name: `${artifactId}.txt`,
          mimeType: "text/plain",
          size: artifactId.length,
        })),
      );
    let snapshot = await f.mutate(
      {
        type: "enqueue",
        lane: "steer",
        text: "original",
        artifactIds: ["first"],
      },
      { stageComposerMessage: true, resolveAttachments },
    );
    const rowId = snapshot.rows[0]!.id;
    expect(snapshot.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual(["first"]);
    expect(f.tx.message.create).not.toHaveBeenCalled();

    await f.mutate({ type: "edit-begin", id: rowId });
    snapshot = await f.mutate({
      type: "edit-patch",
      patch: { text: "edited" },
    });
    expect(snapshot.editing!.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual([
      "first",
    ]);
    snapshot = await f.mutate(
      { type: "edit-patch", patch: { artifactIds: ["draft"] } },
      { resolveAttachments },
    );
    expect(snapshot.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual(["first"]);
    expect(snapshot.editing!.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual([
      "draft",
    ]);
    snapshot = await f.mutate({ type: "edit-cancel" });
    expect(snapshot.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual(["first"]);

    await f.mutate({ type: "edit-begin", id: rowId });
    await f.mutate(
      {
        type: "edit-patch",
        patch: { text: "delivered", artifactIds: ["final"] },
      },
      { resolveAttachments },
    );
    snapshot = await f.mutate({ type: "edit-save" });
    expect(snapshot.rows[0]).toMatchObject({
      text: "delivered",
      lane: "steer",
    });
    expect(snapshot.rows[0]!.attachments?.map((item) => item.artifactId)).toEqual(["final"]);
    expect(f.tx.message.create).not.toHaveBeenCalled();

    await f.mutate({ type: "resume" });
    const send = vi.fn(async (row) => {
      expect(row.text).toBe("delivered");
      expect(row.blocks).toEqual([
        {
          kind: "file",
          artifactId: "final",
          name: "final.txt",
          mimeType: "text/plain",
          size: 5,
        },
      ]);
      return { outcome: "accepted" as const };
    });
    const notifyDeliveredMessage = vi.fn().mockResolvedValue(undefined);
    await dispatchPremoveQueue(f.prisma, lease, "turn-end", {
      send,
      notifyDeliveredMessage,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(notifyDeliveredMessage).toHaveBeenCalledWith("thread", 1);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
    expect(f.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "user",
        runId: "run",
        clientNonce: expect.stringMatching(/^queue-delivery:/),
        blocks: [
          { kind: "text", text: "delivered" },
          {
            kind: "file",
            artifactId: "final",
            name: "final.txt",
            mimeType: "text/plain",
            size: 5,
          },
        ],
      }),
    });
    expect(f.state()!.view.rows).toEqual([]);
  });

  it("stages owned messages only once and retains file attachments for the runtime", async () => {
    const f = fixture();
    const input = {
      ...scope,
      messageId: "message",
      blocks: [
        { kind: "text" as const, text: "original" },
        {
          kind: "file" as const,
          artifactId: "artifact",
          name: "fake.txt",
          mimeType: "text/plain",
          size: 4,
        },
      ],
    };
    expect(await f.prisma.$transaction((tx) => stagePremoveSteeringInTransaction(tx, input))).toBe(
      false,
    );
    await f.mutate({ type: "pause" });
    expect(await f.prisma.$transaction((tx) => stagePremoveSteeringInTransaction(tx, input))).toBe(
      true,
    );
    expect(await f.prisma.$transaction((tx) => stagePremoveSteeringInTransaction(tx, input))).toBe(
      true,
    );
    expect(f.state()!.view.rows).toHaveLength(1);
    const rowId = f.state()!.view.rows[0]!.id;
    await f.mutate({ type: "edit-begin", id: rowId });
    await f.mutate({ type: "edit-patch", patch: { text: "edited" } });
    await f.mutate({ type: "edit-save" });
    await f.mutate({ type: "resume" });
    const send = vi.fn(async (row) => {
      expect(row.text).toBe("edited");
      expect(row.blocks).toEqual(input.blocks.slice(1));
      return { outcome: "accepted" as const };
    });
    await dispatchPremoveQueue(f.prisma, lease, "turn-end", { send });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
