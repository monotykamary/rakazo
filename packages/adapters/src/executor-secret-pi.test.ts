import { describe, expect, it, vi } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { secretPausedToolResult } from "./run-secret.js";

describe("Pi secret pause", () => {
  it("persists protected-input pause without inventing a finished-work response", async () => {
    const harness = await createRpcHarness({
      tool: { name: "request_secret", args: { label: "Enter code", purpose: "otp" } },
    });
    const executeTool = vi.fn(async () => secretPausedToolResult());
    let checkpoint: unknown;
    try {
      const events = await harness.run({
        tools: [
          {
            name: "request_secret",
            description: "Collect protected input",
            inputSchema: {
              type: "object",
              properties: { label: { type: "string" }, purpose: { type: "string" } },
            },
          },
        ],
        executeTool,
        session: {
          save: async (state) => {
            checkpoint = state;
          },
        },
      });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(JSON.stringify(checkpoint)).toContain('"secret":"paused"');
      expect(events.filter((event) => event.type === "text")).toEqual([]);
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 30000);
});
