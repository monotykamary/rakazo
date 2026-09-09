import type { AgentSteeringMessage } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { combinePremoveMessages, deliverPremoveDrain } from "./premove-drain.js";

it("delivers all FIFO texts and images in one standard prompt", async () => {
  const images = [1, 2, 3].map((value) => ({
    name: `image-${value}`,
    mimeType: "image/png" as const,
    data: new Uint8Array([value]),
  }));
  const messages = [
    { id: "a", messageId: "a", text: "first", images: images.slice(0, 2) },
    { id: "b", messageId: "b", text: "second" },
    { id: "c", messageId: "c", text: "", images: images.slice(2) },
  ];
  const deliver = vi.fn(async (_message: AgentSteeringMessage) => {});
  expect(await deliverPremoveDrain(messages, "attempt", { deliver })).toEqual({
    outcome: "accepted",
  });
  expect(deliver).toHaveBeenCalledExactlyOnceWith({
    id: "queue-drain:attempt",
    messageId: "queue-drain:attempt",
    text: "first\n\nsecond\n\n",
    images,
  });
  expect(messages[0]!.images).toHaveLength(2);
});

it("does not acknowledge a failed runtime delivery", async () => {
  await expect(
    deliverPremoveDrain([{ id: "a", messageId: "a", text: "first" }], "attempt", {
      deliver: async () => {
        throw new Error("disconnected");
      },
    }),
  ).rejects.toThrow("disconnected");
});

it("preserves the common target and refuses an empty drain", () => {
  expect(
    combinePremoveMessages(
      [
        {
          id: "a",
          messageId: "a",
          text: "first",
          participantId: "child",
          placement: { cwd: "project" },
        },
        { id: "b", messageId: "b", text: "second", participantId: "child" },
      ],
      "attempt",
    ),
  ).toMatchObject({
    participantId: "child",
    placement: { cwd: "project" },
    text: "first\n\nsecond",
  });
  expect(() => combinePremoveMessages([], "empty")).toThrow();
});
