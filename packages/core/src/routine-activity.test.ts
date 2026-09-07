import { describe, expect, it } from "vitest";
import { projectMessages, routineChangeBlock, routineChangeMessage } from "./events.js";
import { projectMessageActivity } from "./message-activity.js";

const event = {
  id: "event",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  seq: 8,
  type: "routine.updated",
  createdAt: "2026-09-01T00:00:00Z",
  payload: { routineId: "routine", name: "Daily report", messageId: "message", messageSeq: 3 },
};
describe("routine activity evidence", () => {
  it("replays the same persisted message identity and anchors it under its run's reply", () => {
    const routine = routineChangeMessage(event)!;
    expect(projectMessages([event])).toEqual([routine]);
    const result = projectMessageActivity([
      routine,
      {
        ...routine,
        id: "reply",
        role: "bot" as const,
        blocks: [{ kind: "text" as const, text: "Updated the report." }],
      },
    ]);
    expect(result.messages.map((row) => row.id)).toEqual(["reply"]);
    expect(result.activities.get("reply")).toEqual([
      {
        kind: "routine",
        botId: "bot",
        routineId: "routine",
        name: "Daily report",
        action: "updated",
      },
    ]);
  });
  it("rejects missing IDs, missing names and unrelated payloads", () => {
    expect(routineChangeBlock({ type: "routine.updated", payload: { name: "Daily" } })).toBeNull();
    expect(routineChangeBlock({ type: "routine.updated", payload: { routineId: "r" } })).toBeNull();
    expect(routineChangeBlock({ ...event, type: "thread.progress" })).toBeNull();
  });
  it("does not attach a manual change to an unrelated bot reply", () => {
    const result = projectMessageActivity([routineChangeMessage({ ...event, runId: undefined })!]);
    expect(result.messages[0]?.id).toBe("message");
    expect(result.activities.has("message")).toBe(true);
  });
});
