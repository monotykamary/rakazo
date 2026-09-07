import { describe, expect, it } from "vitest";
import {
  assertModelVisible,
  isModelHidden,
  ModelHiddenError,
  ModelVisibilitySchema,
} from "./model-visibility.js";

describe("model visibility contract", () => {
  it("matches exact canonical providers and models without mutating preferences", () => {
    const visibility = ModelVisibilitySchema.parse({
      hide: [{ provider: "local" }, { provider: "remote", model: "small/v2" }],
    });
    expect(isModelHidden(visibility, "local", "anything")).toBe(true);
    expect(isModelHidden(visibility, "remote", "small/v2")).toBe(true);
    expect(isModelHidden(visibility, "remote", "small/v20")).toBe(false);
    expect(isModelHidden(visibility, "Remote", "small/v2")).toBe(false);
    expect(isModelHidden(visibility, "rakazo-broker", "small/v2")).toBe(false);
    expect(() => assertModelVisible(visibility, "remote", "small/v2")).toThrow(ModelHiddenError);
    expect(() => assertModelVisible({ hide: [] }, "remote", "small/v2")).not.toThrow();
    expect(visibility.hide).toHaveLength(2);
  });
  it.each(["*", "?", `${"a*".repeat(100)}b`, "a?b", "\u0000"])(
    "rejects unsafe pattern/control input %j",
    (model) => {
      expect(ModelVisibilitySchema.safeParse({ hide: [{ provider: "test", model }] }).success).toBe(
        false,
      );
    },
  );
  it("bounds network rule input and rejects unknown authority fields", () => {
    for (const hide of [
      [{ provider: "p".repeat(101) }],
      [{ provider: "p", model: "m".repeat(301) }],
      Array.from({ length: 101 }, () => ({ provider: "p" })),
      [{ provider: "" }],
    ]) {
      expect(ModelVisibilitySchema.safeParse({ hide }).success).toBe(false);
    }
    expect(ModelVisibilitySchema.safeParse({ hide: [], userId: "someone-else" }).success).toBe(
      false,
    );
    expect(
      ModelVisibilitySchema.safeParse({ hide: [{ provider: "p", enabled: false }] }).success,
    ).toBe(false);
  });
});
