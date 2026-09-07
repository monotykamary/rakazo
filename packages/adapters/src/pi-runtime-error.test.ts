import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

describe("Pi runtime errors", () => {
  it("propagates actual provider failures instead of completing with error text", async () => {
    const harness = await createRpcHarness({ error: true });
    try {
      await expect(harness.run()).rejects.toThrow();
      expect(harness.requests.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
    expect(harness.host.reaped).toBe(harness.host.starts);
  }, 30000);
});
