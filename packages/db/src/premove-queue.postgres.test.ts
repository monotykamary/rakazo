import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { clearThread } from "./events.js";
import {
  dispatchPremoveQueue,
  listPremoveQueue,
  mutatePremoveQueue,
  wakePremoveQueue,
} from "./premove-queue.js";
import { setRuntimePlacement } from "./runtime-placement.js";
import { createRuntimeSession } from "./runtime-sessions.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describePostgres("durable queue and session (PostgreSQL)", () => {
  const id = `queue-test-${randomUUID()}`;
  const actor: Actor = {
    userId: `${id}-user`,
    spaceId: `${id}-space`,
    email: `${id}@example.test`,
    isDeploymentOwner: false,
  };
  const scope = { spaceId: actor.spaceId, threadId: `${id}-thread`, botId: `${id}-bot` };
  const lease = { ...scope, runId: `${id}-run`, leaseOwner: "test-worker", leaseFence: 1 };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: actor.userId, name: "Queue Test", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id, name: "Queue Test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId: id, name: "Queue Test" },
    });
    await prisma.bot.create({
      data: {
        id: scope.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Queue Test",
        color: "test",
      },
    });
    await prisma.thread.create({
      data: {
        id: scope.threadId,
        spaceId: actor.spaceId,
        botId: scope.botId,
        userId: actor.userId,
      },
    });
    await prisma.task.create({
      data: { id: `${id}-task`, ...scope, userId: actor.userId, prompt: "test", status: "running" },
    });
    await prisma.run.create({
      data: {
        id: lease.runId,
        ...scope,
        taskId: `${id}-task`,
        userId: actor.userId,
        status: "running",
        trigger: "user",
        leaseOwner: lease.leaseOwner,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.organization.deleteMany({ where: { id } });
      await prisma.user.deleteMany({ where: { id: actor.userId } });
      await close();
    }
  });
  it("serializes revision conflicts and commits reservations before real transport callbacks", async () => {
    const mutation = {
      ...scope,
      requestId: "one",
      expectedRevision: 0,
      operation: { type: "enqueue" as const, lane: "steer" as const, text: "one" },
    };
    const replies = await Promise.all([
      mutatePremoveQueue(prisma, actor, mutation),
      mutatePremoveQueue(prisma, actor, { ...mutation, requestId: "two" }),
    ]);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    const snapshot = await listPremoveQueue(prisma, actor, scope);
    await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "resume",
      expectedRevision: snapshot.revision,
      operation: { type: "resume" },
    });
    await dispatchPremoveQueue(prisma, lease, "turn-end", {
      send: async (row) => {
        expect((await listPremoveQueue(prisma, actor, scope)).uncertainRowIds).toEqual([row.id]);
        return { outcome: "uncertain" };
      },
    });
    const uncertain = await listPremoveQueue(prisma, actor, scope);
    expect(uncertain.paused).toBe(true);
    expect(uncertain.rows).toHaveLength(1);
    await expect(
      listPremoveQueue(prisma, { ...actor, userId: "foreign" }, scope),
    ).rejects.toThrow();
  });
  it("freezes project/worktree placement, retains actual acknowledgments and rejects computer drift", async () => {
    const mutate = async (operation: import("@rakazo/contracts").QueueOperation) => {
      const current = await listPremoveQueue(prisma, actor, scope);
      const reply = await mutatePremoveQueue(prisma, actor, {
        ...scope,
        requestId: randomUUID(),
        expectedRevision: current.revision,
        operation,
      });
      expect(reply.ok).toBe(true);
      return reply.snapshot;
    };
    const old = await listPremoveQueue(prisma, actor, scope);
    for (const row of old.rows) await mutate({ type: "remove", id: row.id });
    const computer = await prisma.computer.create({
      data: {
        id: `${id}-computer`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "dedicated",
        scopeKey: `${id}-computer`,
        homeKey: `${id}-home`,
        kind: "fake",
      },
    });
    await prisma.bot.update({ where: { id: scope.botId }, data: { computerId: computer.id } });
    const unbound = await mutate({ type: "enqueue", lane: "steer", text: "bound intent" });
    expect(unbound.rows[0]!.placement?.kind).toBe("unbound");
    const unavailable = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "no-project",
      expectedRevision: unbound.revision,
      operation: { type: "bind-placement", id: unbound.rows[0]!.id },
    });
    expect(unavailable.ok).toBe(false);
    const placement = {
      computerId: computer.id,
      homeKey: computer.homeKey,
      projectPath: "projects/one",
      worktreePath: "worktrees/feature",
    };
    await setRuntimePlacement(prisma, lease, placement, async () => {});
    const enqueued = await mutate({ type: "bind-placement", id: unbound.rows[0]!.id });
    expect(enqueued.rows[0]!.id).toBe(unbound.rows[0]!.id);
    const rebound = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "rebind-project",
      expectedRevision: enqueued.revision,
      operation: { type: "bind-placement", id: enqueued.rows[0]!.id },
    });
    expect(rebound.ok).toBe(false);
    const rowId = enqueued.rows[0]!.id;
    await setRuntimePlacement(
      prisma,
      lease,
      { ...placement, projectPath: "projects/two", worktreePath: undefined },
      async () => {},
    );
    expect((await listPremoveQueue(prisma, actor, scope)).rows[0]!.placement).toMatchObject(
      placement,
    );
    await mutate({ type: "resume" });
    await dispatchPremoveQueue(prisma, lease, "turn-end", {
      validatePlacement: async (bound) => {
        expect(bound).toMatchObject(placement);
      },
      send: async (row) => {
        expect(row.placement).toMatchObject(placement);
        return { outcome: "accepted" };
      },
    });
    const ack = await prisma.event.findFirst({
      where: {
        runId: lease.runId,
        type: "queue.dispatch",
        payload: { path: ["rowId"], equals: rowId },
      },
      orderBy: { seq: "desc" },
    });
    expect(ack?.payload).toMatchObject({ rowId, outcome: "accepted" });
    await mutate({ type: "enqueue", lane: "steer", text: "do not move computers" });
    await prisma.bot.update({ where: { id: scope.botId }, data: { computerId: null } });
    let sent = false;
    await dispatchPremoveQueue(prisma, lease, "turn-end", {
      validatePlacement: async () => {},
      send: async () => {
        sent = true;
        return { outcome: "accepted" };
      },
    });
    expect(sent).toBe(false);
    expect((await listPremoveQueue(prisma, actor, scope)).paused).toBe(true);
  });

  it("adopts legacy steering atomically and coalesces private queue wakeups without a copied prompt", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Legacy Queue", color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: actor.spaceId, botId: bot.id, userId: actor.userId },
    });
    const target = { spaceId: actor.spaceId, threadId: thread.id, botId: bot.id };
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "older" }],
      },
    });
    await prisma.steeringMessage.create({
      data: { botId: bot.id, userId: actor.userId, messageId: message.id },
    });
    const reply = await mutatePremoveQueue(prisma, actor, {
      ...target,
      expectedRevision: 0,
      requestId: "adopt-native",
      operation: { type: "enqueue", lane: "steer", text: "newer" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.snapshot.rows.map((row) => row.text)).toEqual(["older", "newer"]);
    expect(await prisma.steeringMessage.count({ where: { botId: bot.id } })).toBe(0);
    await mutatePremoveQueue(prisma, actor, {
      ...target,
      expectedRevision: reply.snapshot.revision,
      requestId: "wake-native",
      operation: { type: "resume" },
    });
    const [first, second] = await Promise.all([
      wakePremoveQueue(prisma, actor, target),
      wakePremoveQueue(prisma, actor, target),
    ]);
    expect(first).toBeTruthy();
    expect(first).toBe(second);
    const created = await prisma.run.findUniqueOrThrow({
      where: { id: first! },
      include: { task: true },
    });
    expect(created.sourceMessageId).toBeNull();
    expect(created.task.prompt).toBe("");
    expect(await prisma.run.count({ where: { threadId: thread.id } })).toBe(1);
  });

  it("parks queued intent durably when a runtime fails without a graceful-pause request", async () => {
    const initial = await listPremoveQueue(prisma, actor, scope);
    const enqueued = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "terminal-enqueue",
      expectedRevision: initial.revision,
      operation: { type: "enqueue", lane: "followUp", text: "Keep this intent" },
    });
    const resumed = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "terminal-resume",
      expectedRevision: enqueued.snapshot.revision,
      operation: { type: "resume" },
    });
    expect(resumed.snapshot.paused).toBe(false);
    const send = vi.fn(async () => ({ outcome: "completed" as const }));
    await dispatchPremoveQueue(prisma, lease, "paused", { send });
    const held = await listPremoveQueue(prisma, actor, scope);
    expect(held.paused).toBe(true);
    expect(held.rows.map((row) => row.id)).toEqual(resumed.snapshot.rows.map((row) => row.id));
    expect(held.revision).toBeGreaterThan(resumed.snapshot.revision);
    await dispatchPremoveQueue(prisma, lease, "turn-end", { send });
    expect(send).not.toHaveBeenCalled();
  });

  it("continues an explicitly resumed parked turn with exactly one fenced wake and stable provenance", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Paused Resume", color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: actor.spaceId, botId: bot.id, userId: actor.userId },
    });
    const target = { spaceId: actor.spaceId, threadId: thread.id, botId: bot.id };
    const task = await prisma.task.create({
      data: { ...target, userId: actor.userId, prompt: "parked work", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        ...target,
        taskId: task.id,
        userId: actor.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "test-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const leaseScope = { ...target, runId: run.id, leaseOwner: "test-worker", leaseFence: 1 };
    const rawState = async () =>
      (await prisma.premoveQueue.findUniqueOrThrow({ where: { spaceId_threadId_botId: target } }))
        .state as {
        pausedTurn?: { runId: string; parkedAt: string; leaseFence: number };
        resumeIntent?: { requestId: string };
      };
    const send = async () => ({ outcome: "accepted" as const });
    const before = (await listPremoveQueue(prisma, actor, target)).revision;

    await mutatePremoveQueue(prisma, actor, {
      ...target,
      requestId: "graceful",
      expectedRevision: before,
      operation: { type: "graceful-pause" },
    });
    await dispatchPremoveQueue(prisma, leaseScope, "paused", {
      send,
      gracefulPause: async () => {},
    });
    await dispatchPremoveQueue(prisma, leaseScope, "paused", { send });
    expect((await listPremoveQueue(prisma, actor, target)).paused).toBe(true);
    const stamp = await rawState();
    expect(stamp.pausedTurn).toMatchObject({ runId: run.id, leaseFence: 1 });
    expect(stamp.resumeIntent).toBeUndefined();
    const parkedAt = stamp.pausedTurn!.parkedAt;

    const afterParks = (await listPremoveQueue(prisma, actor, target)).revision;
    const resumeInput = {
      ...target,
      requestId: "resume-1",
      expectedRevision: afterParks,
      operation: { type: "resume" as const },
    };
    expect((await mutatePremoveQueue(prisma, actor, resumeInput)).ok).toBe(true);
    expect((await mutatePremoveQueue(prisma, actor, resumeInput)).ok).toBe(true);
    await dispatchPremoveQueue(prisma, leaseScope, "paused", { send });
    const resumed = await rawState();
    expect(resumed.resumeIntent).toMatchObject({ requestId: "resume-1" });
    expect(resumed.pausedTurn).toMatchObject({ runId: run.id, parkedAt });
    expect((await listPremoveQueue(prisma, actor, target)).paused).toBe(false);

    // The parking run is still live here: a wake during the resume race must not touch it and
    // leaves the accepted intent for the terminal wake after its lease closes.
    expect(await wakePremoveQueue(prisma, actor, target)).toBeNull();
    expect((await rawState()).resumeIntent).toMatchObject({ requestId: "resume-1" });
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: new Date() },
    });

    const wakeId = await wakePremoveQueue(prisma, actor, target);
    expect(wakeId).toBeTruthy();
    expect(wakeId).not.toBe(run.id);
    const created = await prisma.run.findUniqueOrThrow({
      where: { id: wakeId! },
      include: { task: true },
    });
    expect(created.task.prompt).toBe("Continue the paused task.");
    expect(created.trigger).toBe("follow_up");
    const snapshot = await listPremoveQueue(prisma, actor, target);
    expect(created.clientNonce).toBe(`queue-resume:${snapshot.sessionId}:resume-1`);
    expect((await rawState()).pausedTurn).toMatchObject({ runId: run.id });

    expect(await wakePremoveQueue(prisma, actor, target)).toBeNull();
    expect((await mutatePremoveQueue(prisma, actor, resumeInput)).ok).toBe(true);
    expect(await wakePremoveQueue(prisma, actor, target)).toBeNull();
    expect(await prisma.run.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it("fails closed without a wake when the parked turn's session generation drifted", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Paused Drift", color: "test" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: actor.spaceId, botId: bot.id, userId: actor.userId },
    });
    const target = { spaceId: actor.spaceId, threadId: thread.id, botId: bot.id };
    const task = await prisma.task.create({
      data: { ...target, userId: actor.userId, prompt: "drifted work", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        ...target,
        taskId: task.id,
        userId: actor.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "test-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const leaseScope = { ...target, runId: run.id, leaseOwner: "test-worker", leaseFence: 1 };
    const send = async () => ({ outcome: "accepted" as const });
    const revision = (await listPremoveQueue(prisma, actor, target)).revision;
    await mutatePremoveQueue(prisma, actor, {
      ...target,
      requestId: "graceful",
      expectedRevision: revision,
      operation: { type: "graceful-pause" },
    });
    await dispatchPremoveQueue(prisma, leaseScope, "paused", {
      send,
      gracefulPause: async () => {},
    });
    await dispatchPremoveQueue(prisma, leaseScope, "paused", { send });
    await mutatePremoveQueue(prisma, actor, {
      ...target,
      requestId: "resume-drift",
      expectedRevision: (await listPremoveQueue(prisma, actor, target)).revision,
      operation: { type: "resume" },
    });
    await prisma.thread.update({
      where: { id: thread.id },
      data: { historyCompactionGeneration: { increment: 1 } },
    });
    await expect(wakePremoveQueue(prisma, actor, target)).rejects.toThrow("Paused context changed");
    expect(await prisma.run.count({ where: { threadId: thread.id } })).toBe(1);
    const state = (
      await prisma.premoveQueue.findUniqueOrThrow({
        where: { spaceId_threadId_botId: target },
      })
    ).state as { resumeIntent?: { requestId: string } };
    expect(state.resumeIntent).toMatchObject({ requestId: "resume-drift" });
    expect((await listPremoveQueue(prisma, actor, target)).paused).toBe(true);
  });

  it("invalidates sessions and queue together on clear and rejects stale checkpoint save", async () => {
    const session = await createRuntimeSession(prisma, lease);
    await session.save({ version: 1, entries: [], leafId: "fake-leaf" });
    expect((await createRuntimeSession(prisma, lease)).restore).toMatchObject({
      leafId: "fake-leaf",
    });
    await clearThread(prisma, scope);
    expect(await prisma.runtimeSession.count({ where: scope })).toBe(0);
    expect(await prisma.premoveQueue.count({ where: scope })).toBe(0);
    expect(await prisma.runtimePlacement.count({ where: scope })).toBe(0);
    await expect(session.save({ leafId: "stale" })).rejects.toThrow();
  });
  it("persists child steering in the one queue and fences retained session targets", async () => {
    await prisma.run.update({
      where: { id: lease.runId },
      data: {
        status: "running",
        leaseOwner: lease.leaseOwner,
        leaseFence: lease.leaseFence,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.bot.update({ where: { id: scope.botId }, data: { computerId: null } });
    const session = await createRuntimeSession(prisma, lease);
    await session.save({
      rootParticipantId: "previous-product-run",
      participants: {
        child: {
          participantId: "child",
          parentParticipantId: "previous-product-run",
          placement: { cwd: "projects/child" },
          status: "completed",
        },
      },
    });
    const snapshot = await listPremoveQueue(prisma, actor, scope);
    const queued = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "child",
      expectedRevision: snapshot.revision,
      operation: {
        type: "enqueue",
        lane: "steer",
        text: "continue",
        target: { participantId: "child" },
      },
    });
    expect(queued.ok).toBe(true);
    expect(queued.snapshot.rows[0]!.target).toEqual({ participantId: "child" });
    const invalid = await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "foreign-child",
      expectedRevision: queued.snapshot.revision,
      operation: {
        type: "enqueue",
        lane: "steer",
        text: "continue",
        target: { participantId: "foreign" },
      },
    });
    expect(invalid.ok).toBe(false);
    await mutatePremoveQueue(prisma, actor, {
      ...scope,
      requestId: "child-resume",
      expectedRevision: queued.snapshot.revision,
      operation: { type: "resume" },
    });
    let delivered = false;
    await dispatchPremoveQueue(prisma, lease, "turn-end", {
      send: async (row) => {
        const reserved = await listPremoveQueue(prisma, actor, scope);
        expect(reserved.inFlight?.rowIds).toContain(row.id);
        expect(row.target).toMatchObject({ participantId: "child" });
        delivered = true;
        return { outcome: "accepted" };
      },
    });
    expect(delivered).toBe(true);
    expect(
      await prisma.steeringMessage.count({ where: { message: { threadId: scope.threadId } } }),
    ).toBe(0);
  });
});
