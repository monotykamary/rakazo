import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { thinkingLevelFor } from "./pi-runtime.js";

const model = (reasoning: boolean) => ({ reasoning }) as Model<Api>;
describe("Pi agent thinking level", () => {
  it("uses medium rather than off for mandatory reasoning models", () => {
    expect(thinkingLevelFor(model(true))).toBe("medium");
  });
  it("honors per-bot thinking and keeps nonreasoning models off", () => {
    expect(thinkingLevelFor(model(true), "high")).toBe("high");
    expect(thinkingLevelFor(model(false), "high")).toBe("off");
  });
  it("clamps unsupported thinking levels", () => {
    expect(
      thinkingLevelFor(
        {
          ...model(true),
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: null,
          },
        },
        "max",
      ),
    ).toBe("xhigh");
  });
  it("forwards configured reasoning effort through the full RPC model broker", async () => {
    const harness = await createRpcHarness();
    try {
      await harness.run({
        model: { ...harness.request.model, reasoning: true, thinkingLevel: "high" },
      });
      expect(harness.requests[0]?.reasoning_effort).toBe("high");
    } finally {
      await harness.close();
    }
  }, 30000);
});
