import { randomUUID } from "node:crypto";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

it("never lets worker retry replay an exhausted or cooling broker pool", async () => {
  const harness = await createRpcHarness({ error: true, errorStatus: 429 });
  const modelRouting: NonNullable<AgentRunRequest["modelRouting"]> = {
    key: `terminal-test:${randomUUID()}`,
    strategy: "ordered",
    pool: [{ credentialId: "test-connection", model: harness.request.model }],
    fallbacks: [],
  };
  try {
    await expect(harness.run({ modelRouting })).rejects.toThrow();
    expect(harness.requests).toHaveLength(1);
    await expect(harness.run({ runId: "next-root", modelRouting })).rejects.toThrow();
    expect(harness.requests).toHaveLength(1);
    expect(harness.host.reaped).toBe(harness.host.starts);
  } finally {
    await harness.close();
  }
});
