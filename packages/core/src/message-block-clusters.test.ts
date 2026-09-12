import { describe, expect, it } from "vitest";
import {
  artifactImageFanSlots,
  clusterMessageBlocks,
  visibleArtifactImageFanItems,
} from "./message-block-clusters.js";

const image = (id: string) => ({
  kind: "image" as const,
  artifactId: id,
  mimeType: "image/png",
  name: `${id}.png`,
});

describe("clusterMessageBlocks", () => {
  it("groups consecutive images and leaves other blocks in place", () => {
    expect(
      clusterMessageBlocks([
        { kind: "text", text: "Here's the latest output:" },
        image("one"),
        image("two"),
        image("three"),
        {
          kind: "file",
          artifactId: "notes",
          mimeType: "text/plain",
          name: "notes.txt",
          size: 12,
        },
        image("four"),
      ]),
    ).toEqual([
      { type: "block", index: 0, block: { kind: "text", text: "Here's the latest output:" } },
      {
        type: "images",
        index: 1,
        blocks: [image("one"), image("two"), image("three")],
      },
      {
        type: "block",
        index: 4,
        block: {
          kind: "file",
          artifactId: "notes",
          mimeType: "text/plain",
          name: "notes.txt",
          size: 12,
        },
      },
      { type: "images", index: 5, blocks: [image("four")] },
    ]);
  });

  it("does not join images split by another block", () => {
    const clusters = clusterMessageBlocks([
      image("one"),
      { kind: "text", text: "mid" },
      image("two"),
    ]);
    expect(clusters.map((cluster) => cluster.type)).toEqual(["images", "block", "images"]);
  });
});

describe("artifact image fan slots", () => {
  it("keeps a single card upright", () => {
    expect(artifactImageFanSlots(1)).toEqual([{ rotateDeg: 0, offsetX: 0, offsetY: 0, zIndex: 1 }]);
  });

  it("fans later cards toward the front", () => {
    const slots = artifactImageFanSlots(3);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.zIndex).toBeLessThan(slots[2]!.zIndex);
    expect(slots[0]!.offsetX).toBeLessThan(slots[2]!.offsetX);
    expect(slots[0]!.rotateDeg).toBeLessThan(slots[2]!.rotateDeg);
  });

  it("shows the newest cards when the stack is long", () => {
    expect(visibleArtifactImageFanItems(["a", "b", "c", "d", "e"])).toEqual(["b", "c", "d", "e"]);
  });
});
