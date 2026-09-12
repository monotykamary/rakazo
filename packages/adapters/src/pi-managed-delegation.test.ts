import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools, PRIVATE_SUBAGENT_TOOL } from "./builtin-tools.js";
import { ManagedPiRuntime } from "./pi-managed-runtime.js";
import type { NativeAgents } from "./pi-native-agents.js";
import type { AgentProcessHost, JsonRecord, PrivateDuplex } from "./pi-rpc-protocol.js";
import type { ToolBridge } from "./pi-rpc-tool-bridge.js";

type BridgeArgs = ConstructorParameters<typeof ToolBridge>;
const compactReply = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => ({ outcome: "completed" })),
);
const captured = vi.hoisted(
  () =>
    new Map<
      string,
      {
        request: BridgeArgs[0];
        authority: BridgeArgs[1];
        delegate: (args: Record<string, unknown>, label: string) => Promise<unknown>;
        tools: ToolBridge;
      }
    >(),
);
vi.mock("./pi-rpc-tool-bridge.js", async (original) => {
  const actual = await original<typeof import("./pi-rpc-tool-bridge.js")>();
  return {
    ...actual,
    ToolBridge: class extends actual.ToolBridge {
      constructor(...args: BridgeArgs) {
        super(...args);
        captured.set(args[0].runId, {
          request: args[0],
          authority: args[1],
          delegate: async (input, _label) => {
            const { participantId, ...request } = input;
            const result = participantId
              ? await native.get(base.runId)!.dispatcher(args[0].runId)("resume", {
                  id: participantId,
                  task: input.task,
                })
              : await native.get(base.runId)!.dispatcher(args[0].runId)("run", request);
            const value = result as { status: string; error?: string };
            if (value.status === "failed") throw new Error(value.error ?? "failed");
            return result;
          },
          tools: this,
        });
      }
    },
  };
});
const native = vi.hoisted(() => new Map<string, NativeAgents>());
vi.mock("./pi-native-agents.js", async (original) => {
  const actual = await original<typeof import("./pi-native-agents.js")>();
  return {
    ...actual,
    NativeAgents: class extends actual.NativeAgents {
      constructor(...args: ConstructorParameters<typeof NativeAgents>) {
        super(...args);
        native.set(args[0].request.runId, this);
      }
    },
  };
});
// Only the worker transport is simulated. Fabric service and shared tool authority are real.
vi.mock("./pi-rpc-transport.js", async (original) => {
  const actual = await original<typeof import("./pi-rpc-transport.js")>();
  return {
    ...actual,
    JsonPeer: class {
      private model: JsonRecord | undefined;
      private thinkingLevel: unknown = "off";
      constructor(
        _port: PrivateDuplex,
        _handle: unknown,
        private observe: (event: JsonRecord) => void,
        stock = false,
      ) {
        if (!stock)
          queueMicrotask(() => observe({ type: "hello", version: 1, runtimeVersion: "0.85.1" }));
      }
      async request(operation: string, data: JsonRecord = {}) {
        if (operation === "set_model") this.model = { provider: data.provider, id: data.modelId };
        if (operation === "set_thinking_level") this.thinkingLevel = data.level;
        if (operation === "get_state")
          return {
            model: this.model,
            thinkingLevel: this.thinkingLevel,
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          };
        if (operation === "compact") return compactReply();
        if (operation === "prompt") this.observe({ type: "agent_settled" });
        return { version: 1, runtimeVersion: "0.85.1", nativeTools: false };
      }
      async close() {}
    },
  };
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const base: AgentRunRequest = {
  runId: "next-root",
  threadId: "thread",
  botId: "bot",
  prompt: "",
  instructions: "Root policy",
  history: [],
  queueOnly: true,
  tools: [
    PRIVATE_SUBAGENT_TOOL,
    ...builtinAgentTools.filter((tool) => tool.name === "manage_queue"),
  ],
  executeTool: async () => ({ ok: true }),
  model: {
    provider: "openai-compatible",
    id: "offline",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake",
  },
};
function fixture() {
  const stop = vi.fn(async () => undefined);
  const start = vi.fn<AgentProcessHost["start"]>(async () => ({
    rpc: {} as PrivateDuplex,
    bridge: {} as PrivateDuplex,
    stop,
  }));
  const runtime = new ManagedPiRuntime({ host: { start } });
  const run = async (
    exercise: (
      root: NonNullable<ReturnType<typeof captured.get>>,
      control: Parameters<NonNullable<AgentRunRequest["runtimeBoundary"]>>[1],
    ) => Promise<void>,
    overrides: Partial<AgentRunRequest> = {},
  ) => {
    let exercised = false;
    for await (const _event of runtime.run({
      ...base,
      ...overrides,
      runtimeBoundary: async (boundary, control) => {
        if (boundary === "idle" && control.participantId === base.runId && !exercised) {
          exercised = true;
          await exercise(captured.get(base.runId)!, control);
        }
      },
    })) {
      /* Drain the real runtime lifecycle. */
    }
  };
  return { start, stop, run };
}
const restored = {
  rootParticipantId: "old-root",
  participants: {
    child: {
      participantId: "child",
      parentParticipantId: "old-root",
      status: "completed",
      placement: { cwd: "project" },
      session: { marker: "original transcript" },
    },
    grandchild: { participantId: "grandchild", parentParticipantId: "child", status: "completed" },
  },
};

beforeEach(() => {
  captured.clear();
  native.clear();
  vi.unstubAllEnvs();
  compactReply.mockReset().mockResolvedValue({ outcome: "completed" });
});
describe("managed delegation admission", () => {
  it("uses one service ceiling for native recursion and keeps descendants parent-scoped", async () => {
    const f = fixture();
    await f.run(
      async () => {
        const service = native.get(base.runId)!.service;
        await service.run(base.runId, { task: "first" });
        expect(service.snapshot().starts).toBe(3);
        expect(service.snapshot().records.map((entry) => entry.record.depth)).toEqual([1, 2, 3]);
        const grandchild = service.snapshot().records[1]!.record;
        await expect(service.status(base.runId, grandchild.id)).rejects.toThrow(
          "Unknown direct child",
        );
      },
      {
        claimParticipantSteering: async (id) => {
          const service = native.get(base.runId)!.service;
          const depth = native.get(base.runId)!.entry(id)!.record.depth;
          if (depth < 3) await service.run(id, { task: "nested" });
          else await expect(service.run(id, { task: "too deep" })).rejects.toThrow("depth limit");
          return [];
        },
      },
    );
    expect(f.start).toHaveBeenCalledTimes(4);
    expect(f.stop).toHaveBeenCalledTimes(4);
  });

  it("does not charge admission when a pause arrives during asynchronous model preparation", async () => {
    const f = fixture();
    const entered = barrier();
    const release = barrier();
    await f.run(
      async ({ authority }) => {
        const service = native.get(base.runId)!.service;
        const attempt = service.run(base.runId, { task: "pending model" });
        const outcome = expect(attempt).rejects.toThrow();
        await entered.promise;
        authority.gracefulPause = true;
        authority.paused = true;
        release.release();
        await outcome;
        expect(service.snapshot().starts).toBe(0);
        expect(f.start).toHaveBeenCalledTimes(1);
      },
      {
        resolveParticipantModel: async () => {
          entered.release();
          await release.promise;
          return undefined;
        },
      },
    );
  });

  it("authorizes models with Fabric's stable ID and spends no admission on denied scope", async () => {
    const f = fixture();
    const ids: string[] = [];
    await f.run(
      async () => {
        const agents = native.get(base.runId)!;
        await expect(
          agents.dispatcher(base.runId)("run", { task: "denied", model: "provider/denied" }),
        ).rejects.toThrow("denied model");
        await expect(
          agents.dispatcher(base.runId)("run", { task: "denied", tools: ["manage_queue"] }),
        ).rejects.toThrow("outside parent scope");
        expect(agents.service.snapshot().starts).toBe(0);
        expect(f.start).toHaveBeenCalledTimes(1);
        const child = await agents.service.run(base.runId, { task: "allowed", recursive: false });
        expect(child.id).toBe(ids.at(-1));
        expect(captured.get(child.id)!.request.tools).toEqual([]);
        expect(captured.get(child.id)!.request.memory).toBeUndefined();
        expect(child).not.toHaveProperty("checkpoint");
      },
      {
        resolveParticipantModel: async (id, selection) => {
          ids.push(id);
          if (selection?.modelId === "denied") throw new Error("denied model");
          return undefined;
        },
      },
    );
  });

  it("narrows canonical and normalized product tools without granting shell for query-only scopes", async () => {
    const f = fixture();
    const read = { name: "read_file", description: "Read", inputSchema: { type: "object" } };
    const shell = { name: "shell", description: "Shell", inputSchema: { type: "object" } };
    const product = {
      name: "product.search",
      description: "Search",
      inputSchema: { type: "object" },
    };
    await f.run(
      async (root) => {
        const agents = native.get(base.runId)!;
        const normalized = root.tools.catalog.find(
          (tool) => tool.argumentKind === product.name,
        )!.name;
        for (const name of ["grep", "find", product.name, "read_file"])
          await expect(
            agents.dispatcher(base.runId)("run", { task: "denied", tools: [name] }),
          ).rejects.toThrow();
        expect(agents.service.snapshot().starts).toBe(0);
        const result = await agents.service.run(base.runId, {
          task: "read only",
          tools: ["read", normalized],
        });
        expect(captured.get(result.id)!.request.tools.map((tool) => tool.name)).toEqual([
          "run_subagent",
          "read_file",
          product.name,
        ]);
      },
      { tools: [...base.tools, read, shell, product] },
    );
  });

  it("acknowledges native controls and drains explicit stop through worker cleanup", async () => {
    const f = fixture();
    const entered = barrier();
    const finish = barrier();
    await f.run(
      async () => {
        const service = native.get(base.runId)!.service;
        const child = await service.spawn(base.runId, { task: "controlled" });
        await entered.promise;
        await service.steer(base.runId, child.id, "Continue carefully");
        await service.compact(base.runId, child.id);
        compactReply.mockResolvedValueOnce({ accepted: true });
        await expect(service.compact(base.runId, child.id)).rejects.toThrow("not confirmed");
        let stopped = false;
        const stopping = service.stop(base.runId, child.id).then((record) => {
          stopped = true;
          return record;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        finish.release();
        expect((await stopping).status).toBe("stopped");
        expect(f.stop).toHaveBeenCalledTimes(1);
      },
      {
        claimParticipantSteering: async () => {
          entered.release();
          await finish.promise;
          return [];
        },
      },
    );
  });

  it("naturally drains background native spawns before shutting down the root", async () => {
    const f = fixture();
    const entered = barrier();
    const finish = barrier();
    let spawned = false;
    const work = f.run(
      async () => {
        await native.get(base.runId)!.dispatcher(base.runId)("spawn", { task: "background" });
        await entered.promise;
        spawned = true;
      },
      {
        claimParticipantSteering: async () => {
          entered.release();
          await finish.promise;
          return [];
        },
      },
    );
    await expect.poll(() => spawned).toBe(true);
    expect(f.stop).not.toHaveBeenCalled();
    finish.release();
    await work;
    expect(native.get(base.runId)!.service.snapshot().records[0]!.record.status).toBe("completed");
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it("reserves a resumed identity after authorization and before checkpoint/start awaits", async () => {
    const f = fixture();
    const auth = barrier();
    const bothChecking = barrier();
    const saved = barrier();
    const saving = barrier();
    let blockAuth = false;
    let checks = 0;
    const placement = vi.fn(async () => ({
      placement: { cwd: "project" },
      executeTool: async () => ({ ok: true }),
    }));
    await f.run(
      async ({ delegate }) => {
        // Both calls pass the pre-placement checks before either can reserve.
        blockAuth = true;
        const first = delegate({ participantId: "child", task: "one" }, "one");
        const second = delegate({ participantId: "child", task: "two" }, "two");
        const results = Promise.allSettled([first, second]);
        await bothChecking.promise;
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(0);
        blockAuth = false;
        auth.release();
        await saving.promise;
        expect(placement).toHaveBeenCalledTimes(1);
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(1);
        expect(f.start).toHaveBeenCalledTimes(1);
        saved.release();
        const outcomes = await results;
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
          reason: expect.objectContaining({ message: expect.stringContaining("idle") }),
        });
        expect(f.start).toHaveBeenCalledTimes(2);
        // Completion releases the active identity, not its started-budget slot.
        await delegate({ participantId: "child", task: "three" }, "three");
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(2);
      },
      {
        session: {
          restore: restored,
          save: async (state) => {
            expect(state).toMatchObject({ rootParticipantId: "next-root" });
            saving.release();
            await saved.promise;
          },
        },
        authorizeSubagentPlacement: placement,
        assertActive: async () => {
          if (blockAuth) {
            if (++checks === 2) bothChecking.release();
            await auth.promise;
          }
        },
      },
    );
    expect(f.stop).toHaveBeenCalledTimes(3);
  });

  it("admits only the eighth start when two authorized calls race at seven", async () => {
    const f = fixture();
    const auth = barrier();
    const both = barrier();
    let blocked = false;
    let checks = 0;
    await f.run(
      async ({ delegate }) => {
        for (let i = 0; i < 7; i++) await delegate({ task: String(i) }, String(i));
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(7);
        blocked = true;
        const results = Promise.allSettled([
          delegate({ task: "eight" }, "eight"),
          delegate({ task: "nine" }, "nine"),
        ]);
        await both.promise;
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(7);
        blocked = false;
        auth.release();
        const outcomes = await results;
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
          reason: expect.objectContaining({ message: expect.stringContaining("start limit") }),
        });
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(8);
        expect(f.start).toHaveBeenCalledTimes(9);
      },
      {
        assertActive: async () => {
          if (blocked) {
            if (++checks === 2) both.release();
            await auth.promise;
          }
        },
      },
    );
  });

  it.each(["checkpoint", "startup", "termination"])(
    "releases identity after %s failure while retaining its started slot",
    async (failure) => {
      const f = fixture();
      let failSave = false;
      await f.run(
        async ({ delegate, authority }) => {
          if (failure === "checkpoint") failSave = true;
          if (failure === "startup") f.start.mockRejectedValueOnce(new Error("startup failed"));
          if (failure === "termination")
            f.stop.mockRejectedValueOnce(new Error("termination failed"));
          await expect(
            delegate({ participantId: "child", task: "attempt" }, "attempt"),
          ).rejects.toThrow("failed");
          failSave = false;
          expect(native.get(base.runId)!.service.snapshot().starts).toBe(1);
          expect(authority.workerBridges.has("child")).toBe(false);
          await delegate({ participantId: "child", task: "retry" }, "retry");
          expect(native.get(base.runId)!.service.snapshot().starts).toBe(2);
        },
        {
          session: {
            restore: restored,
            save: async () => {
              if (failSave) throw new Error("checkpoint failed");
            },
          },
          authorizeSubagentPlacement: async () => ({
            placement: { cwd: "project" },
            executeTool: async () => ({ ok: true }),
          }),
        },
      );
    },
  );

  it("does not spend start budget for denied placement or foreign/missing lineage", async () => {
    const f = fixture();
    await f.run(
      async ({ delegate }) => {
        await expect(delegate({ participantId: "grandchild" }, "foreign")).rejects.toThrow(
          "Unknown direct child",
        );
        await expect(delegate({ participantId: "missing" }, "missing")).rejects.toThrow(
          "Unknown direct child",
        );
        await expect(delegate({ participantId: "child" }, "denied")).rejects.toThrow("denied");
        expect(native.get(base.runId)!.service.snapshot().starts).toBe(0);
        expect(f.start).toHaveBeenCalledTimes(1);
      },
      {
        session: { restore: restored, save: async () => undefined },
        authorizeSubagentPlacement: async () => {
          throw new Error("denied");
        },
      },
    );
  });

  it("requires compact completion acknowledgment and rejects unsupported or foreign commands", async () => {
    const f = fixture();
    await f.run(
      async (_root, control) => {
        // Restoring the root first compacts for its verified model handoff.
        expect(compactReply).toHaveBeenCalledTimes(1);
        compactReply.mockClear();
        const context = { id: "command", signal: new AbortController().signal };
        expect(await control.command({ kind: "compact" }, context)).toEqual({
          outcome: "completed",
        });
        compactReply.mockResolvedValueOnce({ accepted: true });
        expect(await control.command({ kind: "compact" }, context)).toMatchObject({
          outcome: "uncertain",
        });
        compactReply.mockRejectedValueOnce(new Error("disconnected"));
        expect(await control.command({ kind: "compact" }, context)).toMatchObject({
          outcome: "uncertain",
        });
        expect(
          await control.command({ kind: "compact", participantId: "foreign" }, context),
        ).toMatchObject({ outcome: "rejected" });
        expect(await control.command({ kind: "reload" }, context)).toMatchObject({
          outcome: "uncertain",
        });
        expect(compactReply).toHaveBeenCalledTimes(3);
        expect(
          await control.command({ kind: "participant-await", participantId: "child" }, context),
        ).toEqual({ outcome: "completed" });
        expect(
          await control.command({ kind: "participant-await", participantId: base.runId }, context),
        ).toMatchObject({ outcome: "rejected" });
      },
      { session: { restore: restored, save: async () => undefined } },
    );
  });

  it("waits for an admitted child through cleanup, and cancellation releases only the waiter", async () => {
    const f = fixture();
    const entered = barrier();
    const finish = barrier();
    await f.run(
      async ({ delegate }, control) => {
        const child = delegate({ participantId: "child", task: "resume" }, "resume");
        await entered.promise;
        let completed = false;
        const cancel = new AbortController();
        const waiting = control.command(
          { kind: "participant-await", participantId: "child" },
          { id: "gate", signal: cancel.signal },
        );
        const outcome = waiting.then(
          (value) => value,
          (error: unknown) => error,
        );
        const remaining = control
          .command(
            { kind: "participant-await", participantId: "child" },
            { id: "gate-two", signal: new AbortController().signal },
          )
          .then((value) => {
            completed = true;
            return value;
          });
        await Promise.resolve();
        expect(completed).toBe(false);
        cancel.abort();
        expect(await outcome).toMatchObject({ name: "AbortError" });
        expect(completed).toBe(false);
        finish.release();
        await child;
        expect(await remaining).toEqual({ outcome: "completed" });
        expect(f.stop).toHaveBeenCalledTimes(1);
      },
      {
        session: { restore: restored, save: async () => undefined },
        authorizeSubagentPlacement: async () => ({
          placement: { cwd: "project" },
          executeTool: async () => ({ ok: true }),
        }),
        claimParticipantSteering: async () => {
          entered.release();
          await finish.promise;
          return [];
        },
      },
    );
  });

  it("shares the tool fuse between root and a restored child", async () => {
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "2");
    const f = fixture();
    const executeTool = vi.fn(async () => ({ ok: true }));
    const read = {
      name: "read_file",
      description: "Read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    };
    await f.run(
      async (root) => {
        const invokeRead = (tools: ToolBridge, callId: string) =>
          tools.invoke({
            handle: tools.catalog.find((tool) => tool.name === "read_file")!.handle,
            callId,
            args: { path: "notes.txt" },
          });
        await invokeRead(root.tools, "root-read");
        await root.delegate({ participantId: "child", task: "resume" }, "resume");
        const child = captured.get("child")!;
        await expect(invokeRead(child.tools, "child-read")).rejects.toThrow("tool budget exceeded");
        expect(child.authority).toBe(root.authority);
        expect(root.authority.count).toBe(3);
        expect(executeTool).toHaveBeenCalledTimes(2);
      },
      {
        tools: [...base.tools, read],
        executeTool,
        session: { restore: restored, save: async () => undefined },
        authorizeSubagentPlacement: async () => ({ placement: { cwd: "project" }, executeTool }),
      },
    );
  });

  it("restores direct children into the current root authority without widening child tools or sibling lineage", async () => {
    const f = fixture();
    const steering = vi.fn(async () => []);
    await f.run(
      async (root) => {
        await root.delegate({ participantId: "child", task: "resume" }, "resume");
        const child = captured.get("child")!;
        expect(child.authority).toBe(root.authority);
        expect(child.request.session?.restore).toEqual({ marker: "original transcript" });
        expect(child.request.queueOnly).toBe(false);
        expect(child.request.tools.map((tool) => tool.name)).toEqual(["run_subagent"]);
        expect(native.get(base.runId)!.entry("grandchild")!.record).toMatchObject({
          parentId: "child",
        });
        expect(native.get(base.runId)!.entry("child")!.record).toMatchObject({
          parentId: "next-root",
        });
        expect(steering).toHaveBeenCalledWith("child", []);
        expect(root.authority.request.runId).toBe("next-root");
      },
      {
        session: { restore: restored, save: async () => undefined },
        claimParticipantSteering: steering,
        authorizeSubagentPlacement: async () => ({
          placement: { cwd: "project" },
          executeTool: async () => ({ ok: true }),
        }),
      },
    );
  });
});
