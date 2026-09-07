import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { pruneComputerScreenshotContext } from "./pi-runtime.js";

const tool = {
  name: "computer_observe",
  description: "Observe",
  inputSchema: { type: "object", properties: {} },
};
describe("Pi computer tool dispatch", () => {
  it("forwards screenshots and instructions through actual RPC and the model broker", async () => {
    const harness = await createRpcHarness({ tool: { name: "computer_observe", args: {} } });
    try {
      await harness.run({
        tools: [tool],
        instructions: "Follow the user's instructions.",
        executeTool: async () => ({
          kind: "agent_tool_result",
          content: [
            { type: "text", text: "computer observed" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          details: { frameId: "frame-1" },
        }),
      });
      expect(JSON.stringify(harness.requests[1])).toContain("iVBORw0KGgo=");
      expect(JSON.stringify(harness.requests[0])).toContain("Follow the user's instructions.");
    } finally {
      await harness.close();
    }
  }, 30000);
  it("returns graphical failures through Pi's tool error path and allows recovery", async () => {
    const harness = await createRpcHarness({ tool: { name: "computer_observe", args: {} } });
    try {
      const events = await harness.run({
        tools: [tool],
        executeTool: async () => ({ error: "Screen temporarily busy" }),
      });
      expect(events.at(-1)?.type).toBe("done");
      expect(events).toContainEqual(
        expect.objectContaining({ type: "execution", status: "failed" }),
      );
    } finally {
      await harness.close();
    }
  }, 30000);
  it("keeps only the two latest computer screenshots in model context", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_observe",
      content: [
        { type: "text" as const, text: frameId },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const pruned = pruneComputerScreenshotContext(messages);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([false, true, true]);
  });

  it("reuses the message array when no screenshot needs pruning", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
        timestamp: 1,
      },
    ];

    expect(pruneComputerScreenshotContext(messages)).toBe(messages);
  });
});
