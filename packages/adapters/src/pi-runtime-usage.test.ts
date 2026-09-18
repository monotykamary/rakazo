import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { billedPromptTokens } from "./pi-runtime.js";

describe("Pi runtime billed usage", () => {
  it("adds cache reads and writes to uncached input and sanitizes bad counters", () => {
    expect(
      billedPromptTokens({ input: 12, output: 40, cacheRead: 8_000, cacheWrite: 200 }),
    ).toEqual({ inputTokens: 8_212, outputTokens: 40 });
    expect(
      billedPromptTokens({ input: -1, output: Number.NaN, cacheRead: Infinity, cacheWrite: -2 }),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("bills cached prompt tokens once through the managed RPC aggregator", async () => {
    const harness = await createRpcHarness({ cacheReadTokens: 12 });
    try {
      const events = await harness.run();
      const usage = events.filter((event) => event.type === "usage");
      expect(usage).toEqual([
        expect.objectContaining({
          type: "usage",
          inputTokens: 20,
          outputTokens: 8,
          provider: "openai-compatible",
          model: "offline-model",
        }),
      ]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
