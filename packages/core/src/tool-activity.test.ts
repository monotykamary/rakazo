import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isToolActivityBlock, liveWorkingLabel } from "./tool-activity.js";

function message(id: string, blocks: MessageBlock[]): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    blocks,
    createdAt: "2026-09-10T12:00:00.000Z",
  };
}

describe("tool activity", () => {
  it.each<MessageBlock>([
    { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    { kind: "progress", text: "Using browser", activity: true },
    { kind: "progress", text: "Using brex: list_expenses", activity: true },
  ])("recognizes $kind activity", (block) => {
    expect(isToolActivityBlock(block)).toBe(true);
  });

  it("keeps assistant narration separate from tool activity", () => {
    expect(isToolActivityBlock({ kind: "progress", text: "I’m checking that now." })).toBe(false);
    expect(isToolActivityBlock({ kind: "progress", text: "Using browser" })).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Let me check",
        pendingToolNames: ["browser"],
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({ kind: "progress", text: "Using the search results, I found it." }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using the search results, I found…",
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using these notes, here is a summary.",
      }),
    ).toBe(false);
    expect(isToolActivityBlock({ kind: "text", text: "Done." })).toBe(false);
  });

  it("uses the latest live tool name or short progress as the working label", () => {
    expect(liveWorkingLabel([message("user", [{ kind: "text", text: "Go" }])])).toBeUndefined();
    expect(
      liveWorkingLabel([
        message("progress:run", [
          { kind: "progress", text: "Checking", pendingToolNames: ["read_file"] },
        ]),
      ]),
    ).toBe("Read file");
    expect(
      liveWorkingLabel([
        message("progress:run", [{ kind: "steps", steps: [{ label: "Running commands", count: 1 }] }]),
      ]),
    ).toBe("Running commands");
    expect(
      liveWorkingLabel([
        message("progress:run", [{ kind: "progress", text: "Reading file", activity: true }]),
      ]),
    ).toBe("Reading file");
    expect(
      liveWorkingLabel([
        message("subagent:1", [
          { kind: "subagent", agentId: "1", name: "Reviewer", task: "Review the patch", status: "running" },
        ]),
      ]),
    ).toBe("Reviewer");
  });
});
