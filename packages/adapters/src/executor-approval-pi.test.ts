import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult, resolveDuplicateEffectGate } from "./approval-effect.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

const args = { collection: "notes", title: "Result", body: "Done" };
const tool = {
  name: "destination.write",
  description: "Write",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
};
describe("Pi approval pause", () => {
  it("persists the terminating authorized result and never asks the model for a sibling turn", async () => {
    const harness = await createRpcHarness({ tool: { name: "destination_write", args } });
    const executeTool = vi.fn(async () => approvalPausedToolResult());
    let checkpoint: unknown;
    try {
      const events = await harness.run({
        tools: [tool],
        executeTool,
        session: {
          save: async (state) => {
            checkpoint = state;
          },
        },
      });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(JSON.stringify(checkpoint)).toContain('"approval":"paused"');
      expect(events).toContainEqual(
        expect.objectContaining({ type: "execution", status: "paused" }),
      );
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 30000);
  it("keeps durable approval identity independent of RPC correlation IDs", async () => {
    const harness = await createRpcHarness({ tool: { name: "destination_write", args } });
    const executeTool = vi.fn(async (_name, toolArgs, executionId) => {
      expect(executionId).toMatch(/^run:/);
      expect(approvalEffectKey("run", "destination.write", toolArgs)).toBe(
        approvalEffectKey("run", "destination.write", args),
      );
      expect(resolveDuplicateEffectGate({ status: "approved" }, "destination.write")).toEqual({
        action: "execute",
      });
      return { ok: true };
    });
    try {
      await harness.run({ tools: [tool], executeTool });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(harness.requests).toHaveLength(2);
    } finally {
      await harness.close();
    }
  }, 30000);
});
