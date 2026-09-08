import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { appendThreadReaction } from "./thread-reactions.js";

vi.mock("@rakazo/db", () => ({
  appendEventInTransaction: vi.fn(async () => ({ seq: 4 })),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "reaction" })),
  touchGroupUpdatedAt: vi.fn(),
  IsolationError: class extends Error {},
}));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    message: {
      findFirst: vi.fn(async () => ({ id: "parent" })),
      findUnique: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
    run: { create: vi.fn() },
    task: { create: vi.fn() },
  };
  const prisma = { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) };
  const input = { messageId: "parent", reaction: "❤️" as const, clientNonce: "nonce" };
  const run = (kind: "bot" | "group" = "bot") =>
    appendThreadReaction(
      { prisma: prisma as never },
      { spaceId: "space", userId: "user" } as never,
      (kind === "bot"
        ? { kind, botId: "bot", threadId: "thread" }
        : { kind, groupId: "group", memberBotIds: ["bot"], threadId: "thread" }) as never,
      input,
    );
  return { tx, run };
}
it.each(["bot", "group"] as const)(
  "stores a durable %s reaction without scheduling work",
  async (kind) => {
    const f = fixture();
    expect(await f.run(kind)).toEqual({ eventSeq: 4 });
    expect(f.tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", threadId: "thread" },
      select: { id: true },
    });
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(f.tx, {
      threadId: "thread",
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "parent",
      clientNonce: "nonce",
    });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({ replyToMessageId: "parent" }),
      }),
    );
    expect(touchGroupUpdatedAt).toHaveBeenCalledTimes(kind === "group" ? 1 : 0);
    expect(f.tx.run.create).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
  },
);
it("deduplicates retried client intent", async () => {
  const f = fixture();
  f.tx.message.findUnique.mockResolvedValue({ id: "existing" });
  expect(await f.run()).toEqual({ eventSeq: null });
  expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
  expect(appendEventInTransaction).not.toHaveBeenCalled();
});
it("rejects a missing or cross-thread reaction target", async () => {
  const f = fixture();
  f.tx.message.findFirst.mockResolvedValue(null as never);
  await expect(f.run()).rejects.toThrow();
  expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
});
