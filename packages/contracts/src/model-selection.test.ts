import { describe, expect, it } from "vitest";
import { ModelIdSchema, ModelRoutingSchema, ModelSelectionSchema, usableModelId } from "./index.js";

describe("model ID boundaries", () => {
  it.each([null, undefined, "", "   ", "null", " undefined "])(
    "treats %j as absent, not a pin",
    (modelId) => {
      expect(usableModelId(modelId)).toBeNull();
      expect(ModelIdSchema.safeParse(modelId).success).toBe(false);
    },
  );

  it.each(["null", "undefined"])(
    "rejects sentinel %s in public selection and routing",
    (modelId) => {
      expect(
        ModelSelectionSchema.safeParse({ provider: "test", modelId, thinkingLevel: null }).success,
      ).toBe(false);
      expect(
        ModelRoutingSchema.safeParse({
          version: 1,
          strategy: "ordered",
          credentialIds: ["credential"],
          modelId,
          fallbacks: [],
        }).success,
      ).toBe(false);
      expect(
        ModelRoutingSchema.safeParse({
          version: 1,
          strategy: "ordered",
          credentialIds: ["credential"],
          modelId: "real",
          fallbacks: [{ credentialId: "fallback", modelId }],
        }).success,
      ).toBe(false);
    },
  );

  it("preserves exact free-form model identities and trims surrounding whitespace", () => {
    expect(usableModelId(" test/Null-Model ")).toBe("test/Null-Model");
    expect(
      ModelSelectionSchema.parse({
        provider: "test",
        modelId: " test/Null-Model ",
        thinkingLevel: "high",
      }).modelId,
    ).toBe("test/Null-Model");
  });
});
