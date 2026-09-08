import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";

const choiceTool = {
  name: "ask_user",
  description: "Ask a choice",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question", "options"],
  },
};
describe("Pi choice asks", () => {
  it("persists then emits a tappable ask without an empty-turn fallback", async () => {
    const harness = await createRpcHarness({
      tool: {
        name: "ask_user",
        args: { question: "Which city?", options: ["Berlin", "Seoul", "Toronto"] },
      },
    });
    let saved = false;
    try {
      const events = await harness.run({
        tools: [choiceTool],
        session: {
          save: async () => {
            saved = true;
          },
        },
      });
      expect(saved).toBe(true);
      expect(events).toContainEqual({
        type: "ask",
        text: "Which city?",
        actions: [
          { id: "choice-1", label: "Berlin" },
          { id: "choice-2", label: "Seoul" },
          { id: "choice-3", label: "Toronto" },
        ],
      });
      expect(
        events.some((event) => event.type === "text" && event.text.includes("No response")),
      ).toBe(false);
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 30000);
  it("rejects invalid choices at the authoritative bridge before emitting asks", async () => {
    const harness = await createRpcHarness();
    const events: AgentRuntimeEvent[] = [];
    const input = { ...harness.request, tools: [choiceTool] };
    const bridge = new ToolBridge(
      input,
      new RunAuthority(input, new AbortController().signal),
      (event) => events.push(event),
    );
    try {
      await expect(async () =>
        bridge.invoke({
          handle: bridge.catalog[0]!.handle,
          callId: "empty",
          args: { question: "Which?", options: [] },
        }),
      ).rejects.toThrow();
      expect(events).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
