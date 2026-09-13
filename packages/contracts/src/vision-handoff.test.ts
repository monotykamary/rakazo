import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISION_HANDOFF,
  parseVisionModelRef,
  VisionHandoffSchema,
} from "./vision-handoff.js";

describe("vision handoff preference", () => {
  it("accepts off and a canonical vision model", () => {
    expect(VisionHandoffSchema.parse({ enabled: false, visionModel: null })).toEqual(
      DEFAULT_VISION_HANDOFF,
    );
    expect(VisionHandoffSchema.parse({ enabled: true, visionModel: "openai/gpt-4.1" })).toEqual({
      enabled: true,
      visionModel: "openai/gpt-4.1",
    });
  });
  it("rejects enabled without a model, globs, and extra fields", () => {
    expect(VisionHandoffSchema.safeParse({ enabled: true, visionModel: null }).success).toBe(false);
    expect(VisionHandoffSchema.safeParse({ enabled: true, visionModel: "openai/*" }).success).toBe(
      false,
    );
    expect(
      VisionHandoffSchema.safeParse({
        enabled: false,
        visionModel: null,
        userId: "other",
      }).success,
    ).toBe(false);
  });
  it("parses provider/id identities", () => {
    expect(parseVisionModelRef("openai/gpt-4.1")).toEqual({ provider: "openai", id: "gpt-4.1" });
    expect(parseVisionModelRef("openai")).toBeNull();
    expect(parseVisionModelRef(null)).toBeNull();
  });
});
