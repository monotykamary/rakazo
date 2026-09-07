import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { ManagedPiRuntime } from "./pi-managed-runtime.js";
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
        delegate: BridgeArgs[3];
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
          delegate: args[3],
          tools: this,
        });
      }
    },
  };
});
// Only the worker transport is simulated. Runtime admission and shared tool authority are real.
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
  tools: builtinAgentTools.filter((tool) => ["run_subagent", "manage_queue"].includes(tool.name)),
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
  vi.unstubAllEnvs();
  compactReply.mockReset().mockResolvedValue({ outcome: "completed" });
});
describe("managed delegation admission", () => {
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
      async ({ delegate, authority }) => {
        // Both calls pass the pre-placement checks before either can reserve.
        blockAuth = true;
        const first = delegate({ participantId: "child", task: "one" }, "one");
        const second = delegate({ participantId: "child", task: "two" }, "two");
        const results = Promise.allSettled([first, second]);
        await bothChecking.promise;
        expect(authority.childrenStarted).toBe(0);
        blockAuth = false;
        auth.release();
        await saving.promise;
        await expect.poll(() => placement.mock.calls.length).toBe(2);
        expect(authority.childrenStarted).toBe(1);
        expect(f.start).toHaveBeenCalledTimes(1);
        saved.release();
        const outcomes = await results;
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
          reason: expect.objectContaining({ message: expect.stringContaining("already active") }),
        });
        expect(f.start).toHaveBeenCalledTimes(2);
        // Completion releases the active identity, not its started-budget slot.
        await delegate({ participantId: "child", task: "three" }, "three");
        expect(authority.childrenStarted).toBe(2);
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
      async ({ delegate, authority }) => {
        for (let i = 0; i < 7; i++) await delegate({ task: String(i) }, String(i));
        expect(authority.childrenStarted).toBe(7);
        blocked = true;
        const results = Promise.allSettled([
          delegate({ task: "eight" }, "eight"),
          delegate({ task: "nine" }, "nine"),
        ]);
        await both.promise;
        expect(authority.childrenStarted).toBe(7);
        blocked = false;
        auth.release();
        const outcomes = await results;
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
          reason: expect.objectContaining({ message: expect.stringContaining("budget exceeded") }),
        });
        expect(authority.childrenStarted).toBe(8);
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
          expect(authority.childrenStarted).toBe(1);
          expect(authority.participants.has("child")).toBe(false);
          await delegate({ participantId: "child", task: "retry" }, "retry");
          expect(authority.childrenStarted).toBe(2);
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
      async ({ delegate, authority }) => {
        await expect(delegate({ participantId: "grandchild" }, "foreign")).rejects.toThrow(
          "outside",
        );
        await expect(delegate({ participantId: "missing" }, "missing")).rejects.toThrow("outside");
        await expect(delegate({ participantId: "child" }, "denied")).rejects.toThrow("denied");
        expect(authority.childrenStarted).toBe(0);
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
        expect(await control.command({ kind: "reload" } as never, context)).toMatchObject({
          outcome: "rejected",
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
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "1");
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
        expect(root.authority.count).toBe(2);
        expect(executeTool).toHaveBeenCalledTimes(1);
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
        expect(root.authority.childSessions.get("grandchild")).toMatchObject({
          parentParticipantId: "child",
        });
        expect(root.authority.childSessions.get("child")).toMatchObject({
          parentParticipantId: "next-root",
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
