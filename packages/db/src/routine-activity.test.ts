import { routineChangeMessage } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { appendEvent } from "./events.js";

function database(failEvent = false) {
  const committed: { messages: unknown[]; events: unknown[] } = { messages: [], events: [] };
  const update = vi.fn(async () => ({ nextEventSeq: 8, nextMessageSeq: 4 }));
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const pending = { messages: [] as unknown[], events: [] as unknown[] };
      const result = await callback({
        thread: { update },
        run: { findUnique: async () => ({ status: "running" }) },
        message: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: "message", ...data };
            pending.messages.push(row);
            return row;
          },
        },
        event: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (failEvent) throw new Error("Event insert failed");
            const row = { id: "event", createdAt: new Date("2026-09-01T00:00:00Z"), ...data };
            pending.events.push(row);
            return row;
          },
        },
      });
      committed.messages.push(...pending.messages);
      committed.events.push(...pending.events);
      return result;
    },
  } as unknown as PrismaClient;
  return { prisma, committed, update };
}
const input = {
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  type: "routine.updated" as const,
  payload: { routineId: "routine", name: "Daily report", active: true },
};
describe("routine activity persistence", () => {
  it("commits one metadata-only message and matching event identity without unread spam", async () => {
    const { prisma, committed, update } = database();
    const event = await appendEvent(prisma, input);
    expect(committed.events).toHaveLength(1);
    expect(committed.messages).toHaveLength(1);
    const projected = routineChangeMessage(event);
    expect(projected).toMatchObject({
      id: "message",
      seq: 3,
      botId: "bot",
      runId: "run",
      blocks: [
        { kind: "routine_change", routineId: "routine", name: "Daily report", action: "updated" },
      ],
    });
    expect(committed.messages[0]).toMatchObject({
      id: projected?.id,
      seq: projected?.seq,
      role: "system",
      blocks: projected?.blocks,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );
    expect(JSON.stringify(committed.messages)).not.toContain("prompt");
  });
  it("rolls back message persistence and never publishes when event insertion fails", async () => {
    const { prisma, committed } = database(true);
    const publish = vi.fn();
    await expect(appendEvent(prisma, input, { publish } as never)).rejects.toThrow(
      "Event insert failed",
    );
    expect(committed).toEqual({ messages: [], events: [] });
    expect(publish).not.toHaveBeenCalled();
  });
  it("does not invent links for legacy incomplete routine events", async () => {
    const { prisma, committed } = database();
    await appendEvent(prisma, { ...input, payload: { name: "Legacy" } });
    expect(committed.messages).toEqual([]);
    expect(committed.events).toHaveLength(1);
  });
});
