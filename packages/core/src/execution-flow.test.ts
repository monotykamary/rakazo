import type { ProductEvent } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { projectExecutionPage } from "./execution-flow.js";

const event = (seq: number, runId = "run"): ProductEvent => ({
  id: `event:${seq}`,
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId,
  seq,
  type: "agent.tool.called",
  createdAt: "2026-01-01T00:00:00Z",
  payload: { name: "fabric_exec", args: { code: "return 1" }, calls: [{ id: "nested" }] },
});
it("projects only retained evidence and pages by stable event sequence", () => {
  const page = projectExecutionPage("run", [event(3), event(1), event(2, "foreign")], -1, 1);
  expect(page.events).toEqual([event(1)]);
  expect(page).toMatchObject({ nextCursor: 1, hasMore: true, participants: [{ botId: "bot" }] });
  expect(page.events[0]!.payload).not.toHaveProperty("output");
});
it("does not fabricate missing history or participants", () => {
  expect(projectExecutionPage("run", [], 9, 10)).toEqual({
    runId: "run",
    events: [],
    nextCursor: 9,
    hasMore: false,
    participants: [],
    flow: { nodes: [], edges: [], hasMoreRelatedRuns: false },
  });
});
