import { type BackgroundJobHandlers, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  returnBotMessageOutcome,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import { InMemoryJobQueue } from "./wakeup.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [] },
    );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.senderRunning === false ? null : { id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
    },
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.targetArchived ? null : { id: "bot-target" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
  };
  let transactionAttempts = 0;
  const prisma = {
    bot: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ],
        ),
    },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
  };
}

describe("messaging another bot", () => {
  it("delivers into the target's own chat and wakes it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
        }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(
      harness.tx.thread.update.mock.calls.filter(
        ([call]) => (call as { data?: { unread?: boolean } }).data?.unread,
      ),
    ).toHaveLength(2);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("tells the sender to continue independent work", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "ping",
    });
    expect(sent.ok && sent.note).toContain("async");
    expect(sent.ok && sent.note).toContain("Continue independent work");
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not inherit a request reply link when messaging another bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-other",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not inherit a request reply link for an FYI to the requester", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-target",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 1 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });
});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("loads peer context directly from the source message", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "b",
              fromBotName: "B",
              text: "late FYI",
              intent: "fyi",
            },
          ],
          replyTo: {
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "b",
                toBotName: "B",
                text: "check Gmail",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;
    expect(await loadBotMessageContext(prisma, "message-old")).toMatchObject({
      intent: "fyi",
      repliesToRequest: true,
    });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "message-old" } }),
    );
  });
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: { id: "message-1" } });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(harness.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    );
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("treats a delivery-key unique conflict as a replay", async () => {
    const harness = deps({ uniqueConflictOnCommit: true });
    // After both retries miss and the loser hits P2002, the winner is visible.
    (harness.deps.prisma.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "message-winner",
    });

    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["completed", "failed", "cancelled"] } }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});

describe("durable dispatch across publisher shutdown", () => {
  it("recovers a missed wake in a new queue host and keeps control work responsive", async () => {
    vi.useFakeTimers();
    const stoppedPublisher = new InMemoryJobQueue();
    await stoppedPublisher.close();
    const restarted = new InMemoryJobQueue();
    let finishProject!: () => void;
    const projectGate = new Promise<void>((resolve) => {
      finishProject = resolve;
    });
    try {
      const h = deps();
      h.deps.jobs = stoppedPublisher;
      const queued = new Map<string, { id: string; taskId: string; updatedAt: Date }>();
      const receipt = new Map<string, { runId: string | null }>();
      h.tx.run.create.mockImplementation(async () => {
        const row = {
          id: `project-run-${queued.size + 1}`,
          taskId: "task-1",
          updatedAt: new Date(0),
        };
        queued.set(row.id, row);
        return row;
      });
      h.tx.message.create.mockImplementation(async ({ data }) => {
        if (data.clientNonce) receipt.set(data.clientNonce, { runId: null });
        return { id: "inbound", seq: 1 };
      });
      h.tx.message.update.mockImplementation(async ({ data }) => {
        for (const value of receipt.values()) if (!value.runId) value.runId = data.runId;
        return {};
      });
      h.tx.message.findUnique.mockImplementation(async (args) => {
        const where = args.where as { threadId_clientNonce?: { clientNonce: string } };
        return (
          where.threadId_clientNonce
            ? (receipt.get(where.threadId_clientNonce.clientNonce) ?? null)
            : null
        ) as never;
      });
      h.tx.run.findUnique.mockImplementation(
        async ({ where }) => (queued.get(where.id) ?? { status: "running" }) as never,
      );
      const sent = await messageBot(h.deps, run, sender, {
        bot_id: "bot-target",
        message: "Build the project and run its checks.",
        deliveryKey: "project-request",
      });
      expect(sent).toMatchObject({
        ok: true,
        taskId: "task-1",
        runId: "project-run-1",
        threadId: "thread-target",
      });
      // No live publisher or coordinator process is needed to retain acceptance.
      expect(queued.size).toBe(1);
      h.tx.run.findFirst.mockResolvedValue(null);
      const replayed = await messageBot(h.deps, run, sender, {
        bot_id: "bot-target",
        message: "Build the project and run its checks.",
        deliveryKey: "project-request",
      });
      expect(replayed).toMatchObject({
        ok: true,
        replayed: true,
        taskId: "task-1",
        runId: "project-run-1",
      });
      expect(queued.size).toBe(1);

      const completed: string[] = [];
      const started: string[] = [];
      await restarted.start({
        "run.continue": async ({ runId }) => {
          started.push(runId);
          if (runId.startsWith("project")) await projectGate;
          completed.push(runId);
        },
      } as BackgroundJobHandlers);
      Object.assign(h.deps.prisma, {
        routine: { findMany: vi.fn().mockResolvedValue([]) },
        computer: { findMany: vi.fn().mockResolvedValue([]) },
        messagingOutbound: { findFirst: vi.fn().mockResolvedValue(null) },
      });
      Object.assign(h.deps.prisma.run, {
        findMany: vi.fn(async ({ where }) => (where.trigger ? [] : [...queued.values()])),
      });
      await createJobReconciler({ prisma: h.deps.prisma, jobs: restarted }).reconcileOnce();
      await restarted.enqueue(runContinueJob("project-run-2"));
      await restarted.enqueue(runContinueJob("control-conversation"));
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(["project-run-1", "project-run-2", "control-conversation"]);
      expect(completed).toEqual(["control-conversation"]);
      finishProject();
      await restarted.close();
      expect(completed).toEqual(["control-conversation", "project-run-1", "project-run-2"]);
    } finally {
      finishProject();
      await restarted.close();
      vi.useRealTimers();
    }
  });

  it("queries and rechecks recipient owner and space before committing work", async () => {
    const h = deps();
    await messageBot(h.deps, run, sender, { bot_id: "bot-target", message: "Build this project." });
    expect(h.deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: run.userId, spaceId: run.spaceId, archivedAt: null, temporary: false },
      }),
    );
    expect(h.tx.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot-target", userId: run.userId, spaceId: run.spaceId, archivedAt: null },
      }),
    );
  });
});
