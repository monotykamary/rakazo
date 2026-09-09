import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const queueMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  wake: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  mutatePremoveQueue: queueMocks.mutate,
  wakePremoveQueue: queueMocks.wake,
  listPremoveQueue: queueMocks.list,
}));

it("returns a held snapshot and actionable rejection when a paused context changed", async () => {
  const { PremoveResumeUnavailable } = await import("@rakazo/db");
  const { emptyPremoveQueue } = await import("@rakazo/core");
  const { mutateQueue } = await import("./queue.js");
  const snapshot = { ...emptyPremoveQueue("queue").view, paused: true };
  queueMocks.mutate.mockResolvedValue({
    ok: true,
    requestId: "resume",
    snapshot: { ...snapshot, paused: false },
  });
  queueMocks.wake.mockRejectedValue(new PremoveResumeUnavailable());
  queueMocks.list.mockResolvedValue(snapshot);
  const jobs = { enqueue: vi.fn() };
  const result = await mutateQueue(
    {} as PrismaClient,
    { userId: "user", spaceId: "space" },
    {
      threadId: "thread",
      botId: "bot",
      requestId: "resume",
      expectedRevision: 0,
      operation: { type: "resume" },
    },
    jobs,
  );
  expect(result).toMatchObject({
    ok: false,
    error: "Paused context changed. Send a new instruction.",
    snapshot: { paused: true },
  });
  const { QueueReplySchema } = await import("@rakazo/contracts");
  expect(QueueReplySchema.safeParse(result).success).toBe(true);
  expect(jobs.enqueue).not.toHaveBeenCalled();
});

it("wakes an explicit drain even while its public snapshot stays paused", async () => {
  const { emptyPremoveQueue } = await import("@rakazo/core");
  const { mutateQueue } = await import("./queue.js");
  queueMocks.mutate.mockResolvedValue({
    version: 1,
    ok: true,
    requestId: "drain",
    snapshot: emptyPremoveQueue("queue").view,
  });
  queueMocks.wake.mockResolvedValue("drain-run");
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined) };
  await mutateQueue(
    {} as PrismaClient,
    { userId: "user", spaceId: "space" },
    {
      threadId: "thread",
      botId: "bot",
      requestId: "drain",
      expectedRevision: 0,
      operation: { type: "drain" },
    },
    jobs,
  );
  expect(jobs.enqueue).toHaveBeenCalledOnce();
});

it("resolves queue artifacts for the authorized direct or per-bot group scope", async () => {
  const { resolveQueueAttachments } = await import("./artifacts.js");
  const actor = { userId: "user", spaceId: "space" } as never;
  const artifact = {
    id: "artifact",
    name: "brief.pdf",
    mimeType: "application/pdf",
    size: 42,
    storageKey: "fake/artifact",
  };
  const directPrisma = {
    thread: {
      findFirst: vi.fn().mockResolvedValue({ botId: "bot", groupId: null, group: null }),
    },
    artifact: { findMany: vi.fn().mockResolvedValue([artifact]) },
  };
  const direct = await resolveQueueAttachments(
    { prisma: directPrisma as never },
    actor,
    { threadId: "thread", botId: "bot" },
    ["artifact"],
  );
  expect(direct.blocks).toEqual([
    {
      kind: "file",
      artifactId: "artifact",
      name: "brief.pdf",
      mimeType: "application/pdf",
      size: 42,
    },
  ]);
  expect(directPrisma.artifact.findMany).toHaveBeenCalledWith({
    where: expect.objectContaining({
      botId: "bot",
      groupId: null,
      spaceId: "space",
      userId: "user",
    }),
  });

  const groupPrisma = {
    thread: {
      findFirst: vi.fn().mockResolvedValue({
        botId: null,
        groupId: "group",
        group: { members: [{ botId: "bot" }, { botId: "peer" }] },
      }),
    },
    artifact: { findMany: vi.fn().mockResolvedValue([artifact]) },
  };
  await resolveQueueAttachments(
    { prisma: groupPrisma as never },
    actor,
    { threadId: "group-thread", botId: "bot" },
    ["artifact"],
  );
  expect(groupPrisma.artifact.findMany).toHaveBeenCalledWith({
    where: expect.objectContaining({
      spaceId: "space",
      userId: "user",
      OR: [{ groupId: "group" }, { groupId: null, botId: { in: ["bot", "peer"] } }],
    }),
  });
});

it("rejects a queue artifact that the authorized scope cannot resolve", async () => {
  const { resolveQueueAttachments } = await import("./artifacts.js");
  const prisma = {
    thread: {
      findFirst: vi.fn().mockResolvedValue({ botId: "bot", groupId: null, group: null }),
    },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
  };
  await expect(
    resolveQueueAttachments(
      { prisma: prisma as never },
      { userId: "user", spaceId: "space" } as never,
      { threadId: "thread", botId: "bot" },
      ["foreign"],
    ),
  ).rejects.toMatchObject({ name: "IsolationError" });
});

it("queue and execution routes require authentication before database access", async () => {
  const prisma = {
    thread: { findFirst: vi.fn() },
    bot: { findFirst: vi.fn() },
  } as unknown as PrismaClient;
  const router = createRouter({
    prisma,
    secrets: {},
    sandbox: {},
    home: {},
    events: {},
    jobs: {},
  } as unknown as RouterDeps);
  const client = createRouterClient(router, { context: { actor: null } });
  await expect(client.queue.list({ threadId: "thread", botId: "bot" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    client.queue.mutate({
      threadId: "thread",
      botId: "bot",
      expectedRevision: 0,
      requestId: "request",
      operation: { type: "pause" },
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  for (const operation of [
    {
      type: "enqueue" as const,
      lane: "steer" as const,
      text: "help",
      target: { participantId: "child" },
    },
    { type: "bind-placement" as const, id: "row" },
  ]) {
    await expect(
      client.queue.mutate({
        threadId: "thread",
        botId: "bot",
        expectedRevision: 0,
        requestId: "scoped",
        operation,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
  await expect(client.execution.inspect({ runId: "run", limit: 10 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(prisma.thread.findFirst).not.toHaveBeenCalled();
});
