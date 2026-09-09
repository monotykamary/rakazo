import type { QueueSnapshot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  composerModeFromModifiers,
  composerModeLabel,
  enqueueQueueMessage,
  isMacPlatform,
  queueComposerBlockReason,
} from "./use-queue";

const plain = { altKey: false, ctrlKey: false, metaKey: false };

function snapshot(): QueueSnapshot {
  return {
    version: 1,
    sessionId: "session",
    revision: 7,
    rows: [],
    identity: { nextIdNumber: 1, nextSequence: 1 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
}

describe("composer queue modes", () => {
  it("gives Alt steer precedence and uses Meta for queue", () => {
    expect(composerModeFromModifiers({ ...plain, altKey: true }, true)).toBe("steer");
    expect(composerModeFromModifiers({ ...plain, metaKey: true }, true)).toBe("followUp");
    expect(composerModeFromModifiers({ altKey: true, ctrlKey: true, metaKey: true }, false)).toBe(
      "steer",
    );
  });

  it("uses Control only as the non-Mac fallback", () => {
    expect(composerModeFromModifiers({ ...plain, ctrlKey: true }, false)).toBe("followUp");
    expect(composerModeFromModifiers({ ...plain, ctrlKey: true }, true)).toBe("send");
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });

  it("keeps UI names distinct from the backend lane", () => {
    expect(["send", "steer", "followUp"].map((mode) => composerModeLabel(mode as never))).toEqual([
      "Send",
      "Steer",
      "Queue",
    ]);
  });

  it("rejects structured context before ambiguous group routing", () => {
    expect(
      queueComposerBlockReason({
        hasMentions: true,
        hasReply: false,
        requiresExplicitBot: true,
      }),
    ).toBe("structured-context");
    expect(
      queueComposerBlockReason({
        hasMentions: false,
        hasReply: true,
        requiresExplicitBot: false,
        botId: "bot",
      }),
    ).toBe("structured-context");
    expect(
      queueComposerBlockReason({
        hasMentions: false,
        hasReply: false,
        requiresExplicitBot: true,
      }),
    ).toBe("target-required");
    expect(
      queueComposerBlockReason({
        hasMentions: false,
        hasReply: false,
        requiresExplicitBot: true,
        botId: "bot",
      }),
    ).toBeNull();
  });

  it("enqueues uploaded artifacts against the current revision", async () => {
    const mutate = vi.fn(async (input) => ({
      version: 1 as const,
      requestId: input.requestId,
      ok: true,
      snapshot: snapshot(),
    }));
    await enqueueQueueMessage(
      { list: async () => snapshot(), mutate },
      { threadId: "thread", botId: "bot" },
      { lane: "followUp", text: "next", artifactIds: ["artifact"] },
    );
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread",
        botId: "bot",
        expectedRevision: 7,
        operation: {
          type: "enqueue",
          lane: "followUp",
          text: "next",
          artifactIds: ["artifact"],
        },
      }),
    );
  });
});
