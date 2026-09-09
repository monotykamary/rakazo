import type { ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: () => null,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { pendingOutgoingDraft } from "./CallView";

function snapshot(): ThreadSnapshot {
  return {
    threadId: "thread",
    cursor: 1,
    olderCursor: null,
    run: {
      id: "run",
      botId: "bot",
      threadId: "thread",
      taskId: "task",
      status: "waiting_input",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
    messages: [
      {
        id: "message",
        threadId: "thread",
        seq: 1,
        role: "bot",
        runId: "run",
        createdAt: "2026-01-01T00:00:00Z",
        blocks: [
          {
            kind: "ask",
            text: "Review",
            status: "pending",
            draft: {
              kind: "outgoing_message",
              revision: 1,
              hash: "0".repeat(64),
              status: "pending",
              channel: "email",
              canApprove: true,
              ownerUserId: "owner-fixture",
              fields: { to: ["recipient@example.test"], body: "Review this exact content" },
              editable: ["body"],
            },
          },
        ],
      },
    ],
  };
}

describe("outgoing draft review during calls", () => {
  it("requires on-screen review instead of routing spoken yes/no to generic answers", () => {
    expect(pendingOutgoingDraft(snapshot())).toBe(true);
  });

  it("does not change generic questions or completed and older asks", () => {
    expect(pendingOutgoingDraft(null)).toBe(false);
    const generic = snapshot();
    generic.messages[0]!.blocks = [{ kind: "ask", text: "Which day?", status: "pending" }];
    expect(pendingOutgoingDraft(generic)).toBe(false);
    const complete = snapshot();
    complete.run!.status = "completed";
    expect(pendingOutgoingDraft(complete)).toBe(false);
    const older = snapshot();
    older.messages[0]!.runId = "previous-run";
    expect(pendingOutgoingDraft(older)).toBe(false);
    const answered = snapshot();
    const block = answered.messages[0]!.blocks[0]!;
    if (block.kind === "ask") block.status = "answered";
    expect(pendingOutgoingDraft(answered)).toBe(false);
  });
});
