import type { QueueOperation } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type DurableQueueState,
  emptyPremoveQueue,
  hydratePremoveQueue,
  recoverPremoveQueue,
  updateQueueEditLog,
} from "./premove-queue.js";

async function mutate(state: DurableQueueState, operation: QueueOperation) {
  const queue = await hydratePremoveQueue(state, { send: async () => ({ outcome: "accepted" }) });
  const reply = await queue.request({
    version: 1,
    requestId: `test:${state.view.revision}`,
    expectedRevision: state.view.revision,
    operation,
  });
  expect(reply.ok).toBe(true);
  return {
    ...state,
    checkpoint: queue.checkpoint(),
    view: queue.snapshot(),
    editOperations: updateQueueEditLog(state, operation, queue.snapshot()),
  };
}

describe("durable headless queue", () => {
  it("preserves IDs, attachments, committed order and edit drafts across transactions", async () => {
    let state = emptyPremoveQueue("thread:bot");
    state = await mutate(state, {
      type: "enqueue",
      lane: "steer",
      text: "first",
      images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
    });
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "second" });
    const id = state.view.rows[0]!.id;
    state = await mutate(state, { type: "edit-begin", id });
    state = await mutate(state, { type: "edit-patch", patch: { text: "edited" } });
    state = await mutate(state, { type: "reorder", id, direction: 1 });
    expect(state.view.rows[1]!.id).toBe(id);
    expect(state.checkpoint.rows[0]!.id).toBe(id);
    expect(state.view.editing!.rows.find((row) => row.id === id)!.text).toBe("edited");
    const restart = recoverPremoveQueue(state);
    expect(restart.view.editing).toBeUndefined();
    expect(restart.view.rows[0]!.text).toBe("first");
    state = await mutate(state, { type: "edit-save" });
    expect(state.view.rows[1]).toMatchObject({
      id,
      text: "edited",
      images: [{ data: "ZmFrZQ==" }],
    });
  });

  it("uses strict timeline FIFO and holds the head instead of skipping lanes", async () => {
    let state = emptyPremoveQueue("fifo");
    state = await mutate(state, { type: "enqueue", lane: "followUp", text: "first", paused: true });
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "second" });
    state = await mutate(state, { type: "resume" });
    const send = vi.fn(async () => ({ outcome: "accepted" as const }));
    const queue = await hydratePremoveQueue(state, { send });
    expect(await queue.dispatch("turn-end")).toBe(false);
    expect(await queue.dispatch("settled")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels multi-row edits without losing enqueues or original attachment order", async () => {
    let state = emptyPremoveQueue("edit-cancel");
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "one" });
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "two" });
    const [first, second] = state.view.rows;
    state = await mutate(state, { type: "edit-begin", id: first!.id });
    state = await mutate(state, {
      type: "edit-patch",
      patch: { text: "changed one", lane: "followUp" },
    });
    state = await mutate(state, { type: "edit-select", id: second!.id });
    state = await mutate(state, {
      type: "edit-patch",
      patch: { text: "changed two", paused: true },
    });
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "three" });
    state = await mutate(state, { type: "edit-cancel" });
    expect(state.view.rows.map((row) => row.text)).toEqual(["one", "two", "three"]);
    expect(state.view.rows.every((row) => row.lane === "steer" && !row.paused)).toBe(true);
  });

  it("retains uncertain reservation exactly once and requires explicit reconciliation", async () => {
    let state = emptyPremoveQueue("uncertain");
    state = await mutate(state, { type: "enqueue", lane: "steer", text: "one" });
    state = await mutate(state, { type: "resume" });
    const queue = await hydratePremoveQueue(state, {
      send: async () => ({ outcome: "uncertain" }),
    });
    expect(await queue.dispatch("turn-end")).toBe(true);
    const snapshot = queue.snapshot();
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.uncertainRowIds).toEqual([snapshot.rows[0]!.id]);
    expect(snapshot.paused).toBe(true);
    state = recoverPremoveQueue({ ...state, checkpoint: queue.checkpoint(), view: snapshot });
    const restored = await hydratePremoveQueue(state, { send: vi.fn() });
    expect(await restored.dispatch("idle")).toBe(false);
  });
});
