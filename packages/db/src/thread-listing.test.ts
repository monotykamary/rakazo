import { describe, expect, it } from "vitest";
import { previewFromBlocks, previewFromThread } from "./thread-listing.js";

describe("thread previews", () => {
  it("uses the shared plain text without changing persisted blocks", () => {
    const blocks = [{ kind: "text", text: "Created **Project**" }];
    expect(previewFromBlocks(blocks)).toBe("Created Project");
    expect(blocks[0]?.text).toBe("Created **Project**");
    expect(previewFromBlocks(null)).toBe("");
  });
  it("preserves the fork's cleared-conversation boundary", () => {
    expect(
      previewFromThread({
        sessionStartedAfterSeq: 3,
        messages: [
          { seq: 2, blocks: [{ text: "old" }] },
          { seq: 4, blocks: [{ text: "**current**" }] },
        ],
      }),
    ).toBe("current");
    expect(
      previewFromThread({
        sessionStartedAfterSeq: 4,
        messages: [{ seq: 4, blocks: [{ text: "old" }] }],
      }),
    ).toBe("");
  });
});
