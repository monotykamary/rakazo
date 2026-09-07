import type { Actor } from "@rakazo/contracts";
import { executionFlowRows } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { inspectExecution } from "./execution.js";

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
describe("execution inspection access", () => {
  it("keeps initial delivery a request and contracts same-run ownership without extra reads", async () => {
    const prisma = {
      run: {
        findFirst: vi.fn().mockResolvedValue({
          id: "research",
          threadId: "thread",
          botId: "researcher",
          bot: { name: "Researcher" },
          status: "completed",
          trigger: "bot_message",
          sourceMessageId: "request",
          sourceMessage: {
            id: "request",
            runId: "research",
            replyToMessageId: null,
            blocks: [
              {
                kind: "bot_message_received",
                fromBotId: "chief",
                fromBotName: "Chief",
                text: "Investigate",
                intent: "request",
                returnToMessageId: "outbound",
              },
            ],
          },
        }),
        findMany: vi.fn(),
      },
      event: { findMany: vi.fn().mockResolvedValue([]) },
      message: { findMany: vi.fn(), findUnique: vi.fn() },
    };
    const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
      runId: "research",
      limit: 5,
    });
    expect(
      result.flow.edges.some((edge) => edge.kind === "replies" || edge.kind === "results"),
    ).toBe(false);
    expect(result.flow.nodes.find((node) => node.messageId === "request")?.runId).toBe("research");
    const rows = executionFlowRows(result.flow);
    expect(rows.map((row) => row.node.id)).toEqual(["bot:chief", "bot:researcher"]);
    expect(rows[1]!.parent).toMatchObject({ from: "bot:chief", kind: "messages" });
    expect(rows[1]!.runs.map((node) => node.runId)).toEqual(["research"]);
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });
  it("selects names only alongside owned bounded runs", async () => {
    const run = {
      id: "run",
      threadId: "thread",
      botId: "bot",
      bot: { name: "Planner" },
      status: "running",
      trigger: "user",
      sourceMessageId: "message",
      sourceMessage: { runId: "parent", blocks: [], replyToMessageId: null },
    };
    const prisma = {
      run: {
        findFirst: vi.fn().mockResolvedValue(run),
        findMany: vi.fn().mockResolvedValue([
          {
            ...run,
            id: "parent",
            botId: "other",
            bot: { name: "Researcher" },
            sourceMessageId: null,
            sourceMessage: null,
          },
        ]),
      },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
      runId: "run",
      limit: 5,
    });
    const authorized = {
      spaceId: "space",
      userId: "user",
      thread: { spaceId: "space", userId: "user" },
      bot: { archivedAt: null },
    };
    expect(prisma.run.findFirst).toHaveBeenCalledWith({
      where: { ...authorized, id: "run" },
      select: expect.objectContaining({ bot: { select: { name: true } } }),
    });
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { ...authorized, id: { not: "run" }, OR: [{ id: "parent" }] },
      select: expect.objectContaining({ bot: { select: { name: true } } }),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
    });
    expect(
      result.flow.nodes.filter((node) => node.kind === "run").map((node) => node.name),
    ).toEqual(["Planner", "Researcher"]);
  });
  it.each(["status", "result"])(
    "connects the selected %s sender through the complete outline without owning the reply",
    async (intent) => {
      const run = {
        id: "chief",
        threadId: "thread",
        botId: "chief-bot",
        bot: { name: "Chief" },
        status: "completed",
        trigger: "user",
        sourceMessageId: null,
        sourceMessage: null,
      };
      const prisma = {
        run: {
          findFirst: vi.fn().mockResolvedValue(run),
          findMany: vi.fn().mockResolvedValue([
            {
              ...run,
              id: "continuation",
              trigger: "follow_up",
              sourceMessageId: "reply",
              sourceMessage: {
                id: "reply",
                runId: "unselected",
                replyToMessageId: "question",
                blocks: [
                  {
                    kind: "bot_message_received",
                    fromBotId: "researcher",
                    fromBotName: "Researcher",
                    text: "Recorded reply",
                    returnToMessageId: "delivery-receipt",
                    intent,
                  },
                ],
              },
            },
          ]),
        },
        event: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "sent",
              seq: 1,
              spaceId: "space",
              threadId: "thread",
              runId: "chief",
              botId: "chief-bot",
              type: "thread.message.created",
              createdAt: new Date("2026-01-01"),
              payload: {
                messageId: "question",
                blocks: [
                  {
                    kind: "bot_message_sent",
                    toBotId: "researcher",
                    toBotName: "Researcher",
                    text: "Question",
                  },
                ],
              },
            },
          ]),
        },
      };
      const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
        runId: "chief",
        limit: 5,
      });
      const rows = executionFlowRows(result.flow, "chief");
      expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
        ["bot:chief-bot", 0],
        ["bot:researcher", 1],
      ]);
      expect(rows[0]!.runs.map((node) => node.runId)).toEqual(["chief", "continuation"]);
      expect(rows[0]!.node.status).toBeUndefined();
      expect(result.flow.nodes.some((node) => node.messageId === "delivery-receipt")).toBe(false);
      expect(rows[1]!.node.name).toBe("Researcher");
      expect(rows[1]!.relationships).toContainEqual(
        expect.objectContaining({
          from: "bot:researcher",
          to: "bot:chief-bot",
          kind: "messages",
          evidence: expect.arrayContaining([{ kind: "message", id: "reply" }]),
        }),
      );
      expect(rows[1]!.relationships).toContainEqual(
        expect.objectContaining({
          to: "bot:chief-bot",
          kind: intent === "result" ? "results" : "replies",
        }),
      );
      expect(result.flow.nodes.find((node) => node.id === "message:reply")).not.toHaveProperty(
        "runId",
      );
      expect(result.flow.nodes.some((node) => node.id === "run:unselected")).toBe(false);
      expect(prisma.run.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.run.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.event.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.run.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: actor.spaceId,
            userId: actor.userId,
            thread: { spaceId: actor.spaceId, userId: actor.userId },
            bot: { archivedAt: null },
          }),
          take: 51,
        }),
      );
    },
  );
  it.each([
    {
      blocks: [
        { kind: "bot_message_received", fromBotId: "sender", fromBotName: "Sender", text: "Reply" },
      ],
      sender: true,
    },
    {
      blocks: [{ kind: "bot_message_received", fromBotId: "sender", fromBotName: "Sender" }],
      sender: false,
    },
    {
      blocks: [{ kind: "bot_message_sent", toBotId: "sender", toBotName: "Sender", text: "Sent" }],
      sender: false,
    },
  ])(
    "validates selected sender blocks and preserves the persisted reply target ($sender)",
    async ({ blocks, sender }) => {
      const prisma = {
        run: {
          findFirst: vi.fn().mockResolvedValue({
            id: "run",
            threadId: "thread",
            botId: "bot",
            bot: { name: "Chief" },
            status: "running",
            trigger: "follow_up",
            sourceMessageId: "reply",
            sourceMessage: { id: "reply", runId: null, replyToMessageId: "question", blocks },
          }),
          findMany: vi.fn(),
        },
        event: { findMany: vi.fn().mockResolvedValue([]) },
      };
      const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
        runId: "run",
        limit: 5,
      });
      expect(result.flow.nodes.some((node) => node.id === "bot:sender")).toBe(sender);
      expect(result.flow.edges).toContainEqual(
        expect.objectContaining({
          from: "message:reply",
          to: "message:question",
          kind: "replies",
          evidence: [{ kind: "message", id: "reply" }],
        }),
      );
      expect(prisma.run.findMany).not.toHaveBeenCalled();
    },
  );
  it("does not project sender provenance from related-run or event lookahead", async () => {
    const run = {
      id: "run",
      threadId: "thread",
      botId: "bot",
      bot: { name: "Chief" },
      status: "running",
      trigger: "user",
      sourceMessageId: "source",
      sourceMessage: { id: "source", runId: "parent", blocks: [] },
    };
    const related = Array.from({ length: 51 }, (_, index) => ({
      ...run,
      id: `related-${index}`,
      sourceMessageId: `reply-${index}`,
      sourceMessage: {
        id: `reply-${index}`,
        runId: null,
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: `sender-${index}`,
            fromBotName: `Sender ${index}`,
            text: "Reply",
          },
        ],
      },
    }));
    const prisma = {
      run: {
        findFirst: vi.fn().mockResolvedValue(run),
        findMany: vi.fn().mockResolvedValue(related),
      },
      event: {
        findMany: vi.fn().mockResolvedValue(
          [1, 2].map((seq) => ({
            id: `event-${seq}`,
            seq,
            spaceId: "space",
            threadId: "thread",
            runId: "run",
            botId: "bot",
            type: "thread.message.created",
            createdAt: new Date("2026-01-01"),
            payload: {
              messageId: `event-message-${seq}`,
              blocks: [
                {
                  kind: "bot_message_received",
                  fromBotId: `event-sender-${seq}`,
                  fromBotName: "Event sender",
                  text: "Reply",
                },
              ],
            },
          })),
        ),
      },
    };
    const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
      runId: "run",
      limit: 1,
    });
    expect(result).toMatchObject({
      hasMore: true,
      nextCursor: 1,
      flow: { hasMoreRelatedRuns: true },
    });
    const ids = result.flow.nodes.map((node) => node.id);
    expect(ids).toContain("bot:sender-49");
    expect(ids).not.toContain("bot:sender-50");
    expect(ids).not.toContain("bot:event-sender-2");
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
        where: expect.objectContaining({
          OR: [
            { sourceMessageId: { in: ["event-message-1"] } },
            { sourceMessage: { replyToMessageId: { in: ["event-message-1"] } } },
            {
              sourceMessage: {
                blocks: {
                  array_contains: [
                    { kind: "bot_message_received", returnToMessageId: "event-message-1" },
                  ],
                },
              },
            },
            { id: "parent" },
          ],
        }),
      }),
    );
  });
  it("returns not found before querying events for foreign runs", async () => {
    const prisma = {
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      event: { findMany: vi.fn() },
    };
    await expect(
      inspectExecution(prisma as unknown as PrismaClient, actor, { runId: "foreign", limit: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.event.findMany).not.toHaveBeenCalled();
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space",
          userId: "user",
          thread: { spaceId: "space", userId: "user" },
        }),
      }),
    );
  });
  it("bounds retained event query and returns only actual payloads", async () => {
    const prisma = {
      run: {
        findFirst: vi.fn().mockResolvedValue({
          id: "run",
          threadId: "thread",
          botId: "bot",
          bot: { name: "Chief" },
          status: "running",
          trigger: "user",
          sourceMessageId: null,
          sourceMessage: null,
        }),
      },
      event: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "event",
            seq: 4,
            spaceId: "space",
            threadId: "thread",
            runId: "run",
            botId: "bot",
            type: "thread.subagent",
            createdAt: new Date("2026-01-01"),
            payload: { agentId: "child", status: "running" },
          },
        ]),
      },
    };
    const result = await inspectExecution(prisma as unknown as PrismaClient, actor, {
      runId: "run",
      afterSeq: 3,
      limit: 5,
    });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "run", threadId: "thread", spaceId: "space", seq: { gt: 3 } },
      orderBy: { seq: "asc" },
      take: 6,
    });
    expect(result.events[0]!.payload).toEqual({ agentId: "child", status: "running" });
    expect(result.nextCursor).toBe(4);
  });
});
