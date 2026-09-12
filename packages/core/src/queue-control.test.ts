import { expect, it } from "vitest";
import { translateQueueControl } from "./queue-control.js";

it("translates TUI command rows including scoped gates and session controls", () => {
  expect(translateQueueControl({ kind: "compact", instructions: "preserve decisions" })).toEqual({
    kind: "compact",
    instructions: "preserve decisions",
  });
  expect(translateQueueControl({ kind: "compact" }, { participantId: "child" })).toEqual({
    kind: "compact",
    participantId: "child",
  });
  expect(translateQueueControl({ kind: "fabric-await", peer: "child" })).toEqual({
    kind: "participant-await",
    participantId: "child",
  });
  expect(translateQueueControl({ kind: "fabric-await" }, { participantId: "child" })).toEqual({
    kind: "participant-await",
    participantId: "child",
  });
  expect(() => translateQueueControl({ kind: "fabric-await" })).toThrow(
    "Choose a retained participant",
  );
  expect(() =>
    translateQueueControl({ kind: "fabric-await", peer: "other" }, { participantId: "child" }),
  ).toThrow("differs");
  expect(translateQueueControl({ kind: "model", target: "openai/gpt-5.4" })).toEqual({
    kind: "model",
    target: "openai/gpt-5.4",
  });
  expect(() => translateQueueControl({ kind: "model" })).toThrow("provider/model");
  expect(translateQueueControl({ kind: "thinking", level: "high" }, { participantId: "child" })).toEqual(
    {
      kind: "thinking",
      level: "high",
      participantId: "child",
    },
  );
  expect(() => translateQueueControl({ kind: "thinking" })).toThrow("supported level");
  expect(translateQueueControl({ kind: "reload" })).toEqual({ kind: "reload" });
  expect(translateQueueControl({ kind: "new" }, { participantId: "child" })).toEqual({
    kind: "new",
    participantId: "child",
  });
  expect(translateQueueControl({ kind: "fabric-prewalk" })).toEqual({ kind: "fabric-prewalk" });
});
