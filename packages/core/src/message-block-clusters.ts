import type { MessageBlock } from "@rakazo/contracts";

export type ImageMessageBlock = Extract<MessageBlock, { kind: "image" }>;

export type MessageBlockCluster =
  | { type: "images"; index: number; blocks: ImageMessageBlock[] }
  | { type: "block"; index: number; block: Exclude<MessageBlock, ImageMessageBlock> };

export const ARTIFACT_IMAGE_FAN_MAX_VISIBLE = 4;

export const ARTIFACT_IMAGE_FAN_CARD = {
  width: 220,
  height: 148,
} as const;

export type ArtifactImageFanSlot = {
  rotateDeg: number;
  offsetX: number;
  offsetY: number;
  zIndex: number;
};

export function clusterMessageBlocks(blocks: readonly MessageBlock[]): MessageBlockCluster[] {
  const clusters: MessageBlockCluster[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;
    if (block.kind === "image") {
      const images: ImageMessageBlock[] = [block];
      let next = index + 1;
      while (next < blocks.length && blocks[next]?.kind === "image") {
        images.push(blocks[next] as ImageMessageBlock);
        next += 1;
      }
      clusters.push({ type: "images", index, blocks: images });
      index = next;
      continue;
    }
    clusters.push({ type: "block", index, block });
    index += 1;
  }
  return clusters;
}

export function visibleArtifactImageFanItems<T>(items: readonly T[]): T[] {
  if (items.length <= ARTIFACT_IMAGE_FAN_MAX_VISIBLE) return [...items];
  return items.slice(-ARTIFACT_IMAGE_FAN_MAX_VISIBLE);
}

export function artifactImageFanSlots(count: number): ArtifactImageFanSlot[] {
  const visible = Math.max(1, Math.min(count, ARTIFACT_IMAGE_FAN_MAX_VISIBLE));
  if (visible === 1) {
    return [{ rotateDeg: 0, offsetX: 0, offsetY: 0, zIndex: 1 }];
  }
  return Array.from({ length: visible }, (_, index) => {
    const t = index / (visible - 1);
    return {
      rotateDeg: -12 + t * 16,
      offsetX: -22 * (1 - t),
      offsetY: 8 * (1 - t),
      zIndex: index + 1,
    };
  });
}
