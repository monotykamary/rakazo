import { expect, it } from "vitest";
import { translateQueueControl } from "./queue-control.js";

it("translates only reviewed compact and explicitly scoped gates", () => {
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
  for (const kind of ["reload", "new", "model", "thinking", "fabric-prewalk"] as const) {
    expect(() => translateQueueControl({ kind })).toThrow("Unsupported queued control");
  }
});
