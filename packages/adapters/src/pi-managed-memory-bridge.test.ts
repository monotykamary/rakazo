import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { resolvePiKit } from "@rakazo/pi-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  createManagedKit,
  hybridMemoryProvider,
  type ManagedKit,
  managedHostMemoryProvider,
} from "./pi-managed-kit.js";
import { ManagedPiRuntime } from "./pi-managed-runtime.js";
import type { AgentProcessHost, JsonRecord, PrivateDuplex } from "./pi-rpc-protocol.js";
import type { ToolBridge } from "./pi-rpc-tool-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

// A coding harness may itself be a scoped Fabric child. Do not inherit its tool restrictions
// or mesh routing into the independent offline worker fixture.
const envNames = Object.keys(process.env).filter((name) => /^(PI_|FABRIC_)/.test(name));
beforeAll(() => {
  for (const name of envNames) vi.stubEnv(name, undefined);
});
afterAll(() => vi.unstubAllEnvs());

const ready = { version: 1, runtimeVersion: "0.85.1", nativeTools: false, memory: true };
type BridgeArgs = ConstructorParameters<typeof ToolBridge>;
const captured = new Map<
  string,
  { request: BridgeArgs[0]; authority: BridgeArgs[1]; delegate: BridgeArgs[3] }
>();
const bridgeHandlers: Array<(message: JsonRecord) => Promise<unknown>> = [];
const allObservers: Array<(event: JsonRecord) => void> = [];
// The framed transport test needs the real peer even though the module is mocked.
const actuals = vi.hoisted(() => ({ JsonPeer: undefined as unknown as typeof JsonPeer }));
vi.mock("./pi-rpc-transport.js", async (original) => {
  const actual = await original<typeof import("./pi-rpc-transport.js")>();
  actuals.JsonPeer = actual.JsonPeer;
  return {
    ...actual,
    JsonPeer: class extends actual.JsonPeer {
      constructor(port: PrivateDuplex, handler: unknown, observe: unknown, stock = false) {
        // Only the request/handler surface is under test; never read the fixture duplex.
        super(
          {
            incoming: (async function* () {
              for (;;) await new Promise<never>(() => undefined);
            })(),
            write: async () => undefined,
            close: async () => undefined,
          },
          handler as never,
          observe as never,
          stock,
        );
        void port;
        allObservers.push(observe as (event: JsonRecord) => void);
        if (!stock) {
          bridgeHandlers.push(handler as never);
          queueMicrotask(() =>
            (observe as (event: JsonRecord) => void)({
              type: "hello",
              version: 1,
              runtimeVersion: "0.85.1",
            }),
          );
        }
      }
      private model: JsonRecord | undefined;
      private thinkingLevel: unknown = "off";
      override request(operation: string, data: JsonRecord = {}): Promise<unknown> {
        if (operation === "set_model") this.model = { provider: data.provider, id: data.modelId };
        if (operation === "set_thinking_level") this.thinkingLevel = data.level;
        if (operation === "get_state")
          return Promise.resolve({
            model: this.model,
            thinkingLevel: this.thinkingLevel,
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          });
        if (operation === "compact") return Promise.resolve({ outcome: "completed" });
        if (operation === "prompt") allObservers.at(-1)?.({ type: "agent_settled" });
        if (operation === "initialize") return Promise.resolve(ready);
        return Promise.resolve({});
      }
    },
  };
});
vi.mock("./pi-rpc-tool-bridge.js", async (original) => {
  const actual = await original<typeof import("./pi-rpc-tool-bridge.js")>();
  return {
    ...actual,
    ToolBridge: class extends actual.ToolBridge {
      constructor(...args: BridgeArgs) {
        super(...args);
        captured.set(args[0].runId, { request: args[0], authority: args[1], delegate: args[3] });
      }
    },
  };
});
beforeEach(() => {
  captured.clear();
  bridgeHandlers.length = 0;
  allObservers.length = 0;
});

const base: AgentRunRequest = {
  runId: "root",
  threadId: "thread",
  botId: "bot",
  prompt: "",
  instructions: "Policy",
  history: [],
  queueOnly: true,
  tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
  model: {
    provider: "openai-compatible",
    id: "offline",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake",
  },
};
function runtimeFixture(
  memory: AgentRunRequest["memory"],
  overrides: Partial<AgentRunRequest> = {},
) {
  const stop = vi.fn(async () => undefined);
  const host = {
    start: async () => ({ rpc: {} as PrivateDuplex, bridge: {} as PrivateDuplex, stop }),
  } as AgentProcessHost;
  const runtime = new ManagedPiRuntime({ host });
  let exercised = false;
  return async (
    exercise: (root: {
      request: BridgeArgs[0];
      authority: BridgeArgs[1];
      delegate: BridgeArgs[3];
    }) => Promise<void>,
  ) => {
    for await (const _event of runtime.run(
      {
        ...base,
        ...overrides,
        memory,
        runtimeBoundary: async (boundary, control) => {
          if (boundary === "idle" && control.participantId === base.runId && !exercised) {
            exercised = true;
            await exercise(captured.get(base.runId)!);
          }
        },
      },
      { spaceId: "space", signal: AbortSignal.timeout(15000) },
    )) {
      /* Drain the real runtime lifecycle. */
    }
  };
}
const memoryCall = (data: JsonRecord) => ({ operation: "memory", data });

describe("managed host memory bridge", () => {
  it("serves the root memory authority through the private bridge with runtime validation", async () => {
    const authority = vi.fn(async (call: { action: string }) => ({
      hits: [{ snippet: `remembered ${call.action}` }],
    }));
    await runtimeFixture(authority)(async () => {
      const served = await bridgeHandlers[0]!(
        memoryCall({ action: "recall", args: { query: "goal" } }),
      );
      expect(authority).toHaveBeenCalledWith({
        action: "recall",
        args: { query: "goal" },
        signal: expect.any(AbortSignal),
      });
      expect(served).toMatchObject({ hits: [{ snippet: "remembered recall" }] });
      await expect(bridgeHandlers[0]!(memoryCall({ action: "forget", args: {} }))).rejects.toThrow(
        "Unsupported memory action",
      );
      await expect(
        bridgeHandlers[0]!(memoryCall({ action: "recall", args: "query" })),
      ).rejects.toThrow("Invalid managed RPC object");
    });
  }, 30000);

  it("fails closed for lease pause without calling the authority", async () => {
    const authority = vi.fn(async () => ({}));
    await runtimeFixture(authority)(async (root) => {
      root.authority.paused = true;
      await expect(bridgeHandlers[0]!(memoryCall({ action: "recall", args: {} }))).rejects.toThrow(
        "Managed run is paused",
      );
      expect(authority).not.toHaveBeenCalled();
    });
  }, 30000);

  it("denies delegated children the host memory authority", async () => {
    const authority = vi.fn(async () => ({}));
    await runtimeFixture(authority)(async (root) => {
      await root.delegate({ task: "scoped work", name: "child" }, "exec-one");
      const childId = [...captured.keys()].find((id) => id !== base.runId);
      expect(childId).toBeDefined();
      const child = captured.get(childId!)!;
      expect(child.request.memory).toBeUndefined();
      expect(bridgeHandlers[1]).toBeDefined();
      await expect(
        bridgeHandlers[1]!(memoryCall({ action: "recall", args: { query: "goal" } })),
      ).rejects.toThrow("Host memory is not authorized");
      expect(authority).not.toHaveBeenCalled();
    });
  }, 30000);

  it("carries the memory operation across the real framed peer transport", async () => {
    const make = () => {
      const frames: Uint8Array[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const incoming: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              for (;;) {
                const frame = frames.shift();
                if (frame) return { done: false, value: frame };
                if (ended) return { done: true, value: undefined };
                await new Promise<void>((resolve) => (wake = resolve));
                wake = undefined;
              }
            },
          };
        },
      };
      const port: PrivateDuplex = {
        incoming,
        write: async () => undefined,
        close: async () => undefined,
      };
      return {
        port,
        feed: (frame: Uint8Array) => {
          frames.push(frame);
          wake?.();
        },
        end: () => {
          ended = true;
          wake?.();
        },
      };
    };
    const workerToHost = make();
    const hostToWorker = make();
    // Crosswire: each peer's writes land in the other peer's read queue.
    workerToHost.port.write = async (frame) => hostToWorker.feed(frame);
    hostToWorker.port.write = async (frame) => workerToHost.feed(frame);
    const authority = vi.fn(async (call: { action: string }) => ({ echo: call.action }));
    const RealPeer = actuals.JsonPeer;
    const host = new RealPeer(workerToHost.port, async (message) => {
      if (message.operation !== "memory") throw new Error("Unsupported managed bridge operation");
      const call = message.data as { action: string } | undefined;
      if (!call || typeof call !== "object") throw new Error("Invalid");
      return authority(call);
    });
    const worker = new RealPeer(hostToWorker.port, async () => undefined);
    try {
      await worker.request("memory", { action: "recall", args: { query: "x" } });
      expect(authority).toHaveBeenCalledWith({ action: "recall", args: { query: "x" } });
      await expect(worker.request("unknown", {})).rejects.toThrow("rejected");
      expect(() => worker.request("memory", { action: "recall" }, AbortSignal.abort())).toThrow(
        "aborted",
      );
    } finally {
      host.fail(new Error("done"));
      worker.fail(new Error("done"));
      workerToHost.end();
      hostToWorker.end();
    }
  });

  it("routes source-less expansion and session scope to the local engine, archive default to the host", async () => {
    const host = vi.fn(async () => "archive");
    const local = vi.fn(async () => "session");
    const hybrid = hybridMemoryProvider({ invoke: host } as never, { invoke: local } as never);
    const routed = (action: string, args: Record<string, unknown>) => hybrid.invoke(action, args);
    // Source-less follow pointers and explicit session scope stay on the current runtime engine.
    await expect(routed("expand", { session: "current", entryIds: ["e1"] })).resolves.toBe(
      "session",
    );
    await expect(routed("recall", { scope: "session" })).resolves.toBe("session");
    await expect(routed("sessions", { scope: "session" })).resolves.toBe("session");
    expect(local).toHaveBeenLastCalledWith("sessions", { scope: "session" }, undefined);
    await expect(routed("recall", { session: "current" })).resolves.toBe("session");
    // Foreign logical ids map through and fail closed inside the local engine.
    await expect(routed("recall", { scope: "session:foreign" })).resolves.toBe("session");
    expect(local).toHaveBeenLastCalledWith(
      "recall",
      { scope: "session:foreign", session: "foreign" },
      undefined,
    );
    // Source-bearing pointers and the bare default go to the bot archive.
    await expect(routed("expand", { source: "bot", session: "k" })).resolves.toBe("archive");
    await expect(routed("recall", { source: "bot", query: "x" })).resolves.toBe("archive");
    await expect(routed("recall", { query: "x" })).resolves.toBe("archive");
    await expect(routed("sessions", {})).resolves.toBe("archive");
    await expect(routed("forget", {})).resolves.toBe("archive");
    expect(local).toHaveBeenCalledTimes(5);
  });

  it("proxies kit memory actions to the host and fails closed on the pinned Fabric schemas", async () => {
    const authority = vi.fn(async () => ({ total: 0, hits: [] }));
    const provider = managedHostMemoryProvider(authority, () => false);
    expect((await provider.list()).map((action) => action.name)).toEqual([
      "recall",
      "expand",
      "sessions",
    ]);
    const described = (await provider.describe("recall"))!;
    // The host binds the source, so the public descriptor never requires it.
    expect((described.inputSchema as { required?: string[] }).required ?? []).not.toContain(
      "source",
    );
    // Compaction follow pointers keep their exact-expansion knobs.
    const expand = (await provider.describe("expand"))!;
    const expandProperties = expand.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(expandProperties)).toEqual(
      expect.arrayContaining(["maxEntries", "maxChars"]),
    );
    await expect(provider.invoke("forget", {}, {})).rejects.toThrow("Unknown memory action");
    const signal = new AbortController().signal;
    await provider.invoke("recall", { source: "bot", query: "x" }, { signal });
    expect(authority).toHaveBeenCalledWith({
      action: "recall",
      args: { source: "bot", query: "x" },
      signal,
    });
    const paused = managedHostMemoryProvider(authority, () => true);
    await expect(paused.invoke("recall", { source: "bot" }, {})).rejects.toThrow(/paused/);
    const aborted = managedHostMemoryProvider(authority, () => false);
    await expect(
      aborted.invoke("recall", { source: "bot" }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(authority).toHaveBeenCalledTimes(1);
  });

  it("keeps exact restored-memory expansion usable through real Fabric when the host callback is present", async () => {
    // A pin mismatch is a failure, never a skip.
    resolvePiKit();
    const root = await mkdtemp(join(tmpdir(), "memory-bridge-kit-"));
    let kit: ManagedKit | undefined;
    let runtime: AgentSessionRuntime | undefined;
    try {
      const authority = vi.fn(async () => ({ total: 0, hits: [], archive: true }));
      const manager = SessionManager.inMemory("/work");
      const first = manager.appendMessage({
        role: "user",
        content: "Original goal: preserve exact source " + "old detail ".repeat(2000),
        timestamp: 1,
      });
      kit = await createManagedKit({
        instructions: "Use Fabric through authorized tools only.",
        proxyTools: [],
        scratchRoot: root,
        activity: async () => undefined,
        checkpoint: async () => undefined,
        hostMemory: authority,
      });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const deny = vi.fn(() => {
        throw new Error("Paid model must not run");
      });
      for (const name of ["completeSimple", "complete", "streamSimple", "stream"] as const)
        (modelRuntime as unknown as Record<string, unknown>)[name] = deny;
      const model: Model<Api> = {
        id: "offline",
        name: "offline",
        provider: "test",
        api: "openai-completions",
        baseUrl: "http://invalid.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      };
      runtime = await createAgentSessionRuntime(
        async ({ sessionManager, sessionStartEvent }) => {
          const services = {
            cwd: root,
            agentDir: root,
            modelRuntime,
            settingsManager: SettingsManager.inMemory({
              retry: { enabled: false },
              compaction: { enabled: true, keepRecentTokens: 1000 },
            }),
            resourceLoader: kit!.resourceLoader,
            diagnostics: [],
          };
          return {
            ...(await createAgentSessionFromServices({
              services,
              sessionManager,
              sessionStartEvent,
              model,
              tools: kit!.activeTools,
              noTools: "builtin",
              customTools: kit!.tools,
            })),
            services,
            diagnostics: [],
          };
        },
        { cwd: root, agentDir: root, sessionManager: manager },
      );
      await runtime.session.bindExtensions({});
      await kit.initialize(runtime);
      const tool = runtime.session.agent.state.tools.find((item) => item.name === "fabric_exec");
      if (!tool) throw new Error("Fabric not active");
      const exec = (code: string) => tool.execute("probe", { code }, new AbortController().signal);
      // Source-less expand keeps the exact restored logical-session engine.
      const expanded = await exec(
        `return await memory.expand({session:"current",entryIds:[${JSON.stringify(first)}],maxChars:512});`,
      );
      expect(JSON.stringify(expanded)).toContain("Original goal");
      expect(authority).not.toHaveBeenCalled();
      // Explicit session scope recall stays local; bare default goes to the host archive.
      const scoped = await exec('return await memory.sessions({scope:"session"});');
      expect(JSON.stringify(scoped)).toContain('"scope":"session"');
      expect(authority).not.toHaveBeenCalled();
      const archived = await exec('return await memory.recall({query:"needle"});');
      expect(JSON.stringify(archived)).toContain('"archive":true');
      expect(authority).toHaveBeenCalledWith({
        action: "recall",
        args: { query: "needle" },
        signal: expect.any(AbortSignal),
      });
      // Foreign logical ids stay denied by the local engine, not silently archived.
      authority.mockClear();
      const foreign = await exec('return await memory.recall({scope:"session:foreign"});');
      expect(JSON.stringify(foreign)).toMatch(/outside current authority/);
      expect(authority).not.toHaveBeenCalled();
      // Pause latches the whole bridge closed.
      await kit.pause();
      const latched = await exec('return await memory.recall({query:"needle"});');
      expect(JSON.stringify(latched)).toMatch(/paused/i);
    } finally {
      await kit?.dispose();
      await runtime?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
