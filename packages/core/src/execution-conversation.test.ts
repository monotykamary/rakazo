import { describe, expect, it } from "vitest";
import { participantChatTurns, participantConversationEvents } from "./execution-conversation.js";
import type { ProductEvent } from "@rakazo/contracts";

function event(type: ProductEvent["type"], payload: ProductEvent["payload"]): ProductEvent {
  return {
    id: type,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    runId: "run",
    seq: 1,
    type,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

describe("participant conversation", () => {
  it("keeps events for one nested agent", () => {
    const events = [
      event("thread.subagent", {
        agentId: "child",
        name: "Scout",
        task: "Scan the diff",
        status: "running",
      }),
      event("agent.execution.updated", { participantId: "child", name: "read" }),
      event("agent.execution.updated", { participantId: "other", name: "skip" }),
    ];
    expect(participantConversationEvents(events, "child").map((item) => item.id)).toEqual([
      "thread.subagent",
      "agent.execution.updated",
    ]);
    expect(participantChatTurns(events, "child").map((turn) => turn.role)).toEqual(["user", "bot"]);
  });
});
