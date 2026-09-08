import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { NativeAgents } from "./pi-native-agents.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";

it("keeps child affinity stable on resume and separate from siblings and root", async () => {
  const request: AgentRunRequest = {
    runId: "root",
    botId: "bot",
    threadId: "thread",
    modelSessionId: "root-affinity",
    prompt: "",
    history: [],
    instructions: "",
    model: { provider: "offline", id: "test" },
    tools: [{ name: "run_subagent", description: "Delegate", inputSchema: { type: "object" } }],
    executeTool: async () => ({ ok: true }),
  };
  const authority = new RunAuthority(request, new AbortController().signal);
  const observed: AgentRunRequest[] = [];
  const native = new NativeAgents(
    authority,
    () => {},
    async (child) => {
      observed.push(child);
      return observed.length === 1
        ? { status: "paused", checkpoint: {} }
        : { status: "completed", text: "done" };
    },
  );
  native.bindings.set("root", { request, tools: new ToolBridge(request, authority, () => {}) });
  try {
    const first = await native.service.run("root", { task: "first" });
    expect(first.status).toBe("paused");
    await native.service.resume("root", first.id);
    await native.service.wait("root", first.id);
    const second = await native.service.run("root", { task: "second" });
    expect(observed.map((child) => child.modelSessionId)).toEqual([
      `thread:bot:${first.id}`,
      `thread:bot:${first.id}`,
      `thread:bot:${second.id}`,
    ]);
    expect(new Set(observed.map((child) => child.modelSessionId)).size).toBe(2);
    expect(observed.every((child) => child.modelSessionId !== request.modelSessionId)).toBe(true);
  } finally {
    await native.service.close();
  }
});
