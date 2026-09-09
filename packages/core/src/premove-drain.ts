import { itemCommand } from "pi-queue-steer-factory/headless";
import type { DurableQueueState } from "./premove-queue.js";

/** Capture committed FIFO rows only. Lanes do not divide an explicit drain. */
export function premoveDrainRows(state: DurableQueueState): string[] {
  const view = state.view;
  if (
    view.editing ||
    view.inFlight ||
    view.errorHold ||
    view.compaction ||
    view.gracefulPausePending ||
    view.uncertainRowIds.length ||
    state.checkpoint.uncertainRowIds.length
  )
    return [];
  const head = view.rows[0];
  if (!head) return [];
  const binding = (id: string) => JSON.stringify([state.placements?.[id], state.targets?.[id]]);
  const rows: string[] = [];
  for (const row of view.rows) {
    if (
      row.paused ||
      itemCommand(row) ||
      !state.placements?.[row.id] ||
      state.placements[row.id]!.kind === "unbound" ||
      binding(row.id) !== binding(head.id)
    )
      break;
    rows.push(row.id);
  }
  return rows;
}
