import { expect, it } from "vitest";
import { premoveDrainRows } from "./premove-drain.js";
import { emptyPremoveQueue, recoverPremoveQueue } from "./premove-queue.js";

function state() {
  const state = emptyPremoveQueue("test");
  state.view.rows = ["a", "b", "c"].map((id, index) => ({
    id,
    sequence: index + 1,
    lane: index ? "followUp" : "steer",
    text: id,
    images: [],
  }));
  state.checkpoint.rows = structuredClone(state.view.rows);
  state.placements = Object.fromEntries(
    state.view.rows.map((row) => [
      row.id,
      {
        version: 1,
        kind: "none",
        computerId: null,
        homeKey: null,
        projectPath: null,
        worktreePath: null,
        revision: 0,
      },
    ]),
  );
  return state;
}

it("stops before project and participant binding changes without skipping", () => {
  const queue = state();
  expect(premoveDrainRows(queue)).toEqual(["a", "b", "c"]);
  queue.placements!.b!.revision = 1;
  expect(premoveDrainRows(queue)).toEqual(["a"]);
  queue.placements!.b!.revision = 0;
  queue.targets = { b: { participantId: "child", generation: 1, placement: { cwd: "." } } };
  expect(premoveDrainRows(queue)).toEqual(["a"]);
  delete queue.targets.b;
  queue.view.rows[1]!.paused = true;
  expect(premoveDrainRows(queue)).toEqual(["a"]);
});

it("blocks all safety barriers but permits ordinary pause", () => {
  for (const patch of [
    { errorHold: true },
    { compaction: "manual" as const },
    { gracefulPausePending: true },
    { uncertainRowIds: ["a"] },
    { inFlight: { attemptId: "flight", rowIds: ["a"] } },
    { editing: { selectedId: "a", rows: [] } },
  ]) {
    const queue = state();
    Object.assign(queue.view, patch);
    expect(premoveDrainRows(queue)).toEqual([]);
  }
  const queue = state();
  queue.checkpoint.uncertainRowIds = ["a"];
  queue.drainIntent = { requestId: "drain", rowIds: ["a"] };
  expect(premoveDrainRows(queue)).toEqual([]);
  expect(recoverPremoveQueue(queue).drainIntent).toBeUndefined();
});
