import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

function fixture() {
  const findFirst = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; userId: string } }) =>
      where.id === "owned-bot" && where.spaceId === "owned-space" && where.userId === "owner"
        ? { id: "owned-bot", thread: { id: "owned-thread" } }
        : null,
  );
  const findMany = vi.fn(async (_query: unknown) => []);
  const router = createRouter({
    prisma: { bot: { findFirst }, message: { findMany } },
    env: {},
    secrets: {},
    sandbox: {},
    home: {},
    events: {},
    jobs: {},
  } as unknown as RouterDeps);
  const client = (actor: Actor | null = { userId: "owner", spaceId: "owned-space" } as Actor) =>
    createRouterClient(router, { context: { actor } });
  return { client, findFirst, findMany };
}

describe("peer message page authorization", () => {
  it("requires authentication before accessing the transcript", async () => {
    const f = fixture();
    await expect(
      f.client(null).threads.messages({ botId: "owned-bot", peerBotId: "peer" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "another-user", spaceId: "owned-space" },
    { userId: "owner", spaceId: "another-space" },
  ])("does not read another owner's thread for %j", async (actor) => {
    const f = fixture();
    await expect(
      f.client(actor as Actor).threads.messages({ botId: "owned-bot", peerBotId: "peer" }),
    ).rejects.toThrow();
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(actor) }),
    );
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it("passes the selected peer and cursor to one authorized bounded query", async () => {
    const f = fixture();
    await expect(
      f.client().threads.messages({ botId: "owned-bot", peerBotId: "peer", before: 42 }),
    ).resolves.toEqual({
      threadId: "owned-thread",
      messages: [],
      olderCursor: null,
    });
    expect(f.findMany).toHaveBeenCalledOnce();
    expect(f.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        threadId: "owned-thread",
        seq: { lt: 42 },
        OR: [
          { blocks: { array_contains: [{ kind: "bot_message_sent", toBotId: "peer" }] } },
          { blocks: { array_contains: [{ kind: "bot_message_received", fromBotId: "peer" }] } },
        ],
      },
      orderBy: { seq: "desc" },
      take: expect.any(Number),
    });
  });

  it("rejects group and around-message modes before accessing private peer history", async () => {
    const f = fixture();
    await expect(
      f.client().threads.messages({ groupId: "group", peerBotId: "peer" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.client().threads.messages({ botId: "owned-bot", peerBotId: "peer", around: { seq: 5 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.findMany).not.toHaveBeenCalled();
  });
});
