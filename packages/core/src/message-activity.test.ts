import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { type ActivityMessage, projectMessageActivity } from "./message-activity.js";

const message = (
  id: string,
  runId: string | undefined,
  blocks: MessageBlock[],
  botId = "bot",
): ActivityMessage => ({ id, runId, botId, role: "bot", blocks });
const sent: MessageBlock = {
  kind: "bot_message_sent",
  toBotId: "peer",
  toBotName: "Research",
  text: "Private peer request",
};
const received: MessageBlock = {
  kind: "bot_message_received",
  fromBotId: "peer",
  fromBotName: "Research",
  text: "Private peer answer",
  returnToMessageId: "sent",
};
describe("contextual message activity", () => {
  it("groups the real exchange beneath its reply without exposing peer bodies", () => {
    const result = projectMessageActivity([
      message("sent", "run", [sent]),
      message("received", "return", [received]),
      message("reply", "run", [{ kind: "text", text: "Done" }]),
    ]);
    expect(result.messages.map((row) => row.id)).toEqual(["reply"]);
    expect(result.activities.get("reply")).toEqual([
      { kind: "peer", botId: "bot", peerBotId: "peer", peerBotName: "Research", count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toContain("Private peer");
  });
  it("retains a link when its response is outside the loaded page", () => {
    const result = projectMessageActivity([message("sent", "run", [sent])]);
    expect(result.messages).toEqual([message("sent", "run", [])]);
    expect(result.activities.get("sent")?.[0]).toMatchObject({ kind: "peer", count: 1 });
  });
  it("does not associate another bot or unrelated run with an exchange", () => {
    const result = projectMessageActivity([
      message("sent", "run", [sent]),
      message("other", "run", [{ kind: "text", text: "Other" }], "other"),
      message("unrelated", "next", [{ kind: "text", text: "Next" }]),
    ]);
    expect([...result.activities.keys()]).toEqual(["sent"]);
  });
  it("collapses actual tools and subagents into one execution link per run", () => {
    const result = projectMessageActivity([
      message("steps", "run", [{ kind: "steps", steps: [{ label: "Shell", count: 2 }] }]),
      message("reply", "run", [
        { kind: "text", text: "Done" },
        { kind: "steps", steps: [{ label: "Fabric", count: 1 }] },
      ]),
    ]);
    expect(result.messages.map((row) => row.id)).toEqual(["reply"]);
    expect(result.activities.get("reply")).toEqual([
      { kind: "execution", botId: "bot", runId: "run" },
    ]);
    expect(result.messages[0]?.blocks).toEqual([{ kind: "text", text: "Done" }]);
  });
  it("keeps ordinary empty and text-only chat calm", () => {
    expect(projectMessageActivity([]).activities.size).toBe(0);
    const rows = [message("reply", "run", [{ kind: "text", text: "Updated routine report" }])];
    expect(projectMessageActivity(rows)).toEqual({ messages: rows, activities: new Map() });
  });
  it("keeps activity under the reply when progress arrives afterward", () => {
    const result = projectMessageActivity([
      message("sent", "run", [sent]),
      message("reply", "run", [{ kind: "text", text: "Done" }]),
      message("progress", "run", [{ kind: "progress", text: "Finishing" }]),
    ]);
    expect([...result.activities.keys()]).toEqual(["reply"]);
  });
  it("does not mutate its input", () => {
    const rows = [
      message("sent", "run", [sent]),
      message("reply", "run", [{ kind: "text", text: "Done" }]),
    ];
    const before = JSON.stringify(rows);
    projectMessageActivity(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
