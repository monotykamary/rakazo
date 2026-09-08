import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { AgentService } from "pi-fabric/agents";
import { expect, it } from "vitest";
import { NativeAgents } from "./pi-native-agents.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

it("native pause during drain waits for a held write before interrupting its participant", async () => {
  const root = new AbortController();
  const entered = deferred();
  const safe = deferred();
  const paused = deferred();
  let effectSignal: AbortSignal | undefined;
  let suspends = 0;
  let writes = 0;
  const request: AgentRunRequest = {
    runId: "root",
    botId: "bot",
    threadId: "thread",
    prompt: "",
    history: [],
    instructions: "",
    model: { provider: "offline", id: "test" },
    tools: ["run_subagent", "write_file"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
    })),
    executeTool: async (name, _args, _id, _route, signal) => {
      if (name === "write_file") {
        writes++;
        effectSignal = signal;
        entered.resolve();
        await safe.promise;
      }
      return { ok: true };
    },
  };
  const authority = new RunAuthority(request, root.signal);
  const native = new NativeAgents(
    authority,
    () => {},
    async (child, execution) => {
      const tools = new ToolBridge(child, authority, () => {}, execution.signal);
      native.bindings.set(child.runId, { request: child, tools });
      authority.workerBridges.set(child.runId, {
        request: async (operation: string) => {
          expect(operation).toBe("suspend");
          suspends++;
          expect(effectSignal?.aborted).toBe(false);
          await execution.emit({ type: "checkpoint", checkpoint: { safeWrite: true } });
          paused.resolve();
          return { paused: true };
        },
      } as unknown as JsonPeer);
      await tools.invoke({
        handle: tools.catalog.find((tool) => tool.name === "write_file")!.handle,
        callId: "held",
        args: {},
      });
      await paused.promise;
      return { status: "paused" };
    },
  );
  native.bindings.set("root", { request, tools: new ToolBridge(request, authority, () => {}) });
  try {
    await native.service.spawn("root", { task: "safe write" });
    await entered.promise;
    const draining = native.service.drain();
    authority.gracefulPause = true;
    authority.paused = true;
    const suspension = native.service.suspend();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(suspends).toBe(0);
    expect(effectSignal?.aborted).toBe(false);
    safe.resolve();
    await suspension;
    await draining;
    expect(suspends).toBe(1);
    expect(writes).toBe(1);
    expect(root.signal.aborted).toBe(false);
    expect(native.service.snapshot().records[0]!.record).toMatchObject({
      status: "paused",
      checkpoint: { safeWrite: true },
    });
  } finally {
    safe.resolve();
    paused.resolve();
    await native.service.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("explicit child stop cancels its blocked tool through the fifth signal without aborting root or replaying", async () => {
  const root = new AbortController();
  const entered = deferred();
  let calls = 0;
  let toolSignal: AbortSignal | undefined;
  let bridge!: ToolBridge;
  const request: AgentRunRequest = {
    runId: "root",
    botId: "bot",
    threadId: "thread",
    prompt: "",
    history: [],
    instructions: "",
    model: { provider: "offline", id: "test" },
    tools: [{ name: "write_file", description: "Write", inputSchema: { type: "object" } }],
    executeTool: async (_name, _args, _id, _route, signal) => {
      calls++;
      toolSignal = signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    },
  };
  const authority = new RunAuthority(request, root.signal);
  const service = new AgentService({
    rootId: "root",
    port: {
      execute: async (execution) => {
        bridge = new ToolBridge(
          { ...request, runId: execution.id },
          authority,
          () => {},
          execution.signal,
        );
        await bridge.invoke({ handle: bridge.catalog[0]!.handle, callId: "effect", args: {} });
        return { status: "completed" };
      },
    },
  });
  try {
    const child = await service.spawn("root", { task: "write" });
    await entered.promise;
    await service.stop("root", child.id);
    expect(toolSignal?.aborted).toBe(true);
    expect(root.signal.aborted).toBe(false);
    expect((await service.status("root", child.id)).status).toBe("stopped");
    await expect(
      bridge.invoke({ handle: bridge.catalog[0]!.handle, callId: "effect", args: {} }),
    ).rejects.toThrow("replayed");
    expect(calls).toBe(1);
    await authority.check();
  } finally {
    await service.close();
  }
});
