import type {
  ExecutionInspection,
  QueueMutation,
  QueueOperation,
  QueueReply,
  QueueSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createExecutionStore,
  createQueueStore,
  mergeInspection,
  queueRows,
} from "./queue-client.js";

function snapshot(revision = 0): QueueSnapshot {
  return {
    version: 1,
    sessionId: "session",
    revision,
    rows: [
      { id: "root", sequence: 2, lane: "followUp", text: "First", images: [], paused: true },
      {
        id: "child",
        sequence: 1,
        lane: "steer",
        text: "Second",
        images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
      },
    ],
    identity: { nextIdNumber: 3, nextSequence: 3 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
}
const scope = { threadId: "thread", botId: "bot" };
const operations: QueueOperation[] = [
  { type: "enqueue", lane: "followUp", text: "Third", images: snapshot().rows[1]!.images },
  { type: "edit-begin", id: "root" },
  { type: "edit-patch", patch: { text: "Edited", images: [] } },
  { type: "edit-save" },
  { type: "edit-cancel" },
  { type: "remove", id: "root" },
  { type: "reorder", id: "child", direction: -1 },
  { type: "lane", id: "root", lane: "steer" },
  { type: "hold", id: "root", paused: false },
  { type: "pause" },
  { type: "resume" },
  { type: "graceful-pause" },
];
function inspection(): ExecutionInspection {
  return {
    runId: "run",
    events: [],
    nextCursor: 1,
    hasMore: false,
    participants: [{ botId: "bot", participantId: "child", name: "Worker" }],
    flow: {
      nodes: [
        { id: "run:run", kind: "run", runId: "run", evidence: [{ kind: "run", id: "run" }] },
        {
          id: "child",
          kind: "participant",
          participantId: "child",
          evidence: [{ kind: "event", id: "delegated" }],
        },
      ],
      edges: [
        {
          id: "delegation",
          from: "run:run",
          to: "child",
          kind: "delegates",
          evidence: [{ kind: "event", id: "delegated" }],
        },
      ],
      hasMoreRelatedRuns: false,
    },
  };
}
describe("retained execution controller", () => {
  it("merges node and edge evidence and participants across pages without adding edges or success", () => {
    const first = inspection();
    const page = inspection();
    page.participants = [];
    page.nextCursor = 3;
    page.flow.edges[0]!.evidence = [{ kind: "event", id: "observed-again" }];
    page.flow.nodes[1]!.code = "await tools.read('fixture.ts')";
    const merged = mergeInspection(first, page);
    expect(merged.flow.edges).toHaveLength(1);
    expect(merged.flow.edges[0]!.evidence.map((item) => item.id)).toEqual([
      "delegated",
      "observed-again",
    ]);
    expect(merged.flow.nodes[1]!.code).toBe("await tools.read('fixture.ts')");
    expect(merged.flow.nodes.every((node) => node.status === undefined)).toBe(true);
    expect(merged.participants).toEqual(first.participants);
    expect(merged.nextCursor).toBe(3);
  });
  it("uses the returned event cursor and never conflates related run evidence", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce({ ...inspection(), runId: "other" });
    const store = createExecutionStore({ inspect }, "run");
    await store.loadMore();
    await store.loadMore();
    expect(inspect.mock.calls[1]?.[0]).toEqual({ runId: "run", afterSeq: 1, limit: 100 });
    expect(store.getSnapshot().inspection?.runId).toBe("run");
    expect(store.getSnapshot().error).toContain("scope mismatch");
  });
  it("retains loaded evidence after failure and supports an explicit retry", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(inspection())
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ ...inspection(), nextCursor: 2 });
    const store = createExecutionStore({ inspect }, "run");
    await store.loadMore();
    await store.loadMore();
    expect(store.getSnapshot().inspection?.nextCursor).toBe(1);
    expect(store.getSnapshot().error).toContain("Offline");
    await store.loadMore();
    expect(store.getSnapshot().inspection?.nextCursor).toBe(2);
    expect(store.getSnapshot().error).toBeUndefined();
  });
});

describe("participant steering", () => {
  function scopedInspection() {
    const data = inspection();
    data.events = [
      {
        id: "event",
        spaceId: "space",
        ...scope,
        runId: "run",
        seq: 1,
        type: "run.started",
        createdAt: "2026-07-19T12:00:00Z",
        payload: {},
      },
    ];
    data.participants.push({ botId: "other", participantId: "foreign" }, { botId: "bot" });
    return data;
  }
  function setup() {
    const mutate = vi.fn(
      async (input: QueueMutation): Promise<QueueReply> => ({
        version: 1,
        requestId: input.requestId,
        ok: true,
        snapshot: snapshot(1),
      }),
    );
    const store = createQueueStore({ list: async () => snapshot(), mutate }, scope);
    return { store, mutate };
  }
  it("queues only an inspected same-bot participant in the existing thread scope", async () => {
    const { store, mutate } = setup();
    await store.refresh();
    expect(
      store.steeringParticipants(scopedInspection()).map((item) => item.participantId),
    ).toEqual(["child"]);
    expect(await store.steer(scopedInspection(), "child", "Keep tests offline")).toBe(true);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      ...scope,
      expectedRevision: 0,
      operation: {
        type: "enqueue",
        lane: "steer",
        text: "Keep tests offline",
        target: { participantId: "child" },
      },
    });
  });
  it("rejects missing evidence, foreign threads/bots, unknown participants and empty messages", async () => {
    const { store, mutate } = setup();
    await store.refresh();
    const otherThread = scopedInspection();
    otherThread.events[0]!.threadId = "other";
    const otherBot = scopedInspection();
    otherBot.events[0]!.botId = "other";
    const otherRun = scopedInspection();
    otherRun.runId = "related";
    for (const data of [inspection(), otherThread, otherBot, otherRun]) {
      expect(store.steeringParticipants(data)).toEqual([]);
      expect(await store.steer(data, "child", "hello")).toBe(false);
    }
    expect(await store.steer(scopedInspection(), "foreign", "hello")).toBe(false);
    expect(await store.steer(scopedInspection(), "missing", "hello")).toBe(false);
    expect(await store.steer(scopedInspection(), "child", "  ")).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("preserves the target on snapshot rows and editing previews", () => {
    const data = snapshot();
    data.rows[0]!.target = { participantId: "child" };
    data.editing = {
      selectedId: "root",
      rows: data.rows.map((row) => ({ ...row, removed: false })),
    };
    expect(queueRows(data)[0]!.target).toEqual({ participantId: "child" });
  });
});

describe("queue controls", () => {
  it("keeps server FIFO order, attachments and edit preview identity without a planner", () => {
    const state = snapshot();
    expect(queueRows(state).map((row) => row.id)).toEqual(["root", "child"]);
    expect(queueRows(state)[1]?.images).toEqual(state.rows[1]?.images);
    state.editing = {
      selectedId: "child",
      rows: state.rows.map((row) => ({ ...row, removed: false })),
    };
    expect(queueRows(state)).toBe(state.editing.rows);
  });
  it.each(operations)("sends $type with current revision and owned scope", async (operation) => {
    const mutate = vi.fn(
      async (input: QueueMutation): Promise<QueueReply> => ({
        version: 1,
        requestId: input.requestId,
        ok: true,
        snapshot: snapshot(1),
      }),
    );
    const store = createQueueStore({ list: async () => snapshot(), mutate }, scope);
    await store.refresh();
    expect(await store.mutate(operation)).toBe(true);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ ...scope, expectedRevision: 0, operation });
    expect(store.getSnapshot().snapshot?.revision).toBe(1);
  });
  it("adopts conflicts and requires a new explicit intent", async () => {
    const mutate = vi.fn(
      async (input: QueueMutation): Promise<QueueReply> => ({
        version: 1,
        requestId: input.requestId,
        ok: false,
        error: "Revision conflict",
        snapshot: snapshot(9),
      }),
    );
    const store = createQueueStore({ list: async () => snapshot(), mutate }, scope);
    await store.refresh();
    expect(await store.mutate({ type: "resume" })).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      error: "Revision conflict",
      snapshot: { revision: 9 },
    });
    await store.mutate({ type: "pause" });
    expect(mutate.mock.calls[1]?.[0].expectedRevision).toBe(9);
  });
  it("never retries an ambiguous mutation and blocks writes until reconciled", async () => {
    const list = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("Offline"));
    const mutate = vi.fn().mockRejectedValue(new Error("Lost acknowledgement"));
    const store = createQueueStore({ list, mutate }, scope);
    await store.refresh();
    await store.mutate({ type: "enqueue", lane: "steer", text: "Only once" });
    expect(await store.mutate({ type: "resume" })).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(snapshot(4));
    await store.refresh();
    expect(store.getSnapshot().snapshot?.revision).toBe(4);
  });
  it("rejects overlapping controls and ignores stale polling snapshots", async () => {
    let finish!: (reply: QueueReply) => void;
    const mutate = vi.fn(
      () =>
        new Promise<QueueReply>((resolve) => {
          finish = resolve;
        }),
    );
    const store = createQueueStore({ list: async () => snapshot(), mutate }, scope);
    await store.refresh();
    const pending = store.mutate({ type: "pause" });
    expect(await store.mutate({ type: "resume" })).toBe(false);
    finish({ version: 1, requestId: "test", ok: true, snapshot: snapshot(5) });
    await pending;
    await store.refresh();
    expect(store.getSnapshot().snapshot?.revision).toBe(5);
  });
});
