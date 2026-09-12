import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertModelVisible } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { builtinAgentTools, PRIVATE_SUBAGENT_TOOL } from "./builtin-tools.js";
import type { AgentProcessHost } from "./pi-rpc-protocol.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { AsyncChannel, readJsonFrames } from "./pi-rpc-transport.js";

const children = (state: any): any[] =>
  state?.agents?.records.map((entry: any) => entry.record) ?? [];
const childRecord = (state: any, id: string) => children(state).find((child) => child.id === id);

function observer() {
  const commands: Array<{ type: string; modelId?: string; level?: string }> = [];
  let failCompact = false;
  const probes = new Map<string, (result: Record<string, unknown>) => void>();
  let sendProbe: ((frame: Uint8Array) => Promise<void>) | undefined;
  let probeId = 0;
  const wrapHost = (host: AgentProcessHost): AgentProcessHost => ({
    async start(scope, signal) {
      const connection = await host.start(scope, signal);
      const incoming = new AsyncChannel<Uint8Array>();
      sendProbe = (frame) => connection.rpc.write(frame);
      void (async () => {
        try {
          for await (const frame of readJsonFrames(connection.rpc)) {
            const probe = probes.get(String(frame.id));
            if (probe) {
              probes.delete(String(frame.id));
              probe(frame);
            } else incoming.push(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
          }
          incoming.close();
        } catch (error) {
          incoming.close(error as Error);
        }
      })();
      return {
        ...connection,
        rpc: {
          ...connection.rpc,
          incoming,
          async write(frame) {
            const command = JSON.parse(new TextDecoder().decode(frame));
            commands.push(command);
            if (failCompact && command.type === "compact") {
              incoming.push(
                new TextEncoder().encode(
                  JSON.stringify({
                    id: command.id,
                    type: "response",
                    command: "compact",
                    success: false,
                    error: "offline compaction failure",
                  }) + "\n",
                ),
              );
            } else await connection.rpc.write(frame);
          },
        },
      };
    },
  });
  return {
    commands,
    wrapHost,
    fail: (value: boolean) => {
      failCompact = value;
    },
    async probe(command: Record<string, unknown>) {
      const id = `probe-${++probeId}`;
      const result = new Promise<Record<string, unknown>>((resolve) => probes.set(id, resolve));
      await sendProbe!(new TextEncoder().encode(JSON.stringify({ id, ...command }) + "\n"));
      return result;
    },
  };
}

describe("real managed RPC model handoffs", () => {
  it("does not widen file-only authority through Fabric run, spawn or handoff facades", async () => {
    const code = `const denied = []; for (const ref of ["agents.run", "agents.spawn", "agents.handoff"]) { try { await tools.call({ref, args:{task:"escape",name:"escape",model:"openai-compatible/offline-model"}}); } catch { denied.push(ref); } } return {denied};`;
    const h = await createRpcHarness({ tool: { name: "fabric_exec", args: { code } } });
    let saved: any;
    let executorCalls = 0;
    try {
      await h.run({
        tools: builtinAgentTools.filter((tool) => tool.name === "read_file"),
        executeTool: async () => {
          executorCalls++;
          return { text: "file" };
        },
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      });
      expect(executorCalls).toBe(0);
      expect(h.host.starts).toBe(1);
      expect(h.host.reaped).toBe(1);
      const results = saved.entries.filter(
        (entry: any) => entry.type === "message" && entry.message.role === "toolResult",
      );
      expect(results.at(-1)?.message).toMatchObject({ isError: false, details: { success: true } });
      expect(JSON.stringify(results)).toContain("agents.handoff");
      expect(JSON.stringify(results)).toContain("agents.spawn");
      expect(JSON.stringify(results)).toContain("agents.run");
      expect(children(saved)).toHaveLength(0);
    } finally {
      await h.close();
    }
  }, 60000);

  it("cannot resume a saved Fabric child after delegation authority is removed", async () => {
    const h = await createRpcHarness({
      runTimeoutMs: 60_000,
      tool: { name: "run_subagent", args: { name: "helper", task: "Help" } },
    });
    let saved: any;
    try {
      await h.run({
        tools: [PRIVATE_SUBAGENT_TOOL],
        executeTool: async () => ({ ok: true }),
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      });
      const child = children(saved)[0] as any;
      let delivered = false;
      await expect(
        h.run({
          runId: "file-only-parent",
          prompt: "",
          queueOnly: true,
          tools: builtinAgentTools.filter((tool) => tool.name === "read_file"),
          session: {
            restore: saved,
            save: async (value) => {
              saved = value;
            },
          },
          runtimeBoundary: async (boundary, control) => {
            if (boundary !== "idle" || delivered) return;
            delivered = true;
            await control.deliver({
              id: "resume",
              messageId: "resume",
              participantId: child.id,
              text: "Resume",
            });
          },
        }),
      ).rejects.toThrow("Delegation is outside");
      expect(h.host.starts).toBe(3);
      expect(h.host.reaped).toBe(3);
      expect(childRecord(saved, child.id).checkpoint.session).toEqual(child.checkpoint.session);
    } finally {
      await h.close();
    }
  }, 120000);

  it("finishes an allowed tool but blocks the next hidden inference and hidden restore", async () => {
    const protocol = observer();
    const h = await createRpcHarness({
      wrapHost: protocol.wrapHost,
      tool: { name: "read_file", args: { path: "notes.txt" } },
    });
    let saved: any;
    let hidden = false;
    let toolFinished = false;
    const assertModelAllowed = async (provider: string, modelId: string) => {
      assertModelVisible(
        { hide: hidden ? [{ provider: h.request.model.provider, model: h.request.model.id }] : [] },
        provider,
        modelId,
      );
    };
    try {
      await expect(
        h.run({
          assertModelAllowed,
          tools: [
            {
              name: "read_file",
              description: "Read",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
          session: {
            save: async (value) => {
              saved = value;
            },
          },
          executeTool: async () => {
            hidden = true;
            toolFinished = true;
            return { text: "tool completed" };
          },
        }),
      ).rejects.toThrow();
      expect(toolFinished).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(JSON.stringify(saved.entries)).toContain("tool completed");
      const effective = saved.modelSelection.effective;
      protocol.commands.length = 0;
      await expect(
        h.run({
          runId: "hidden-restore",
          sourceMessageId: "next",
          assertModelAllowed,
          session: {
            restore: saved,
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ).rejects.toThrow("hidden");
      expect(protocol.commands).toHaveLength(0);
      expect(saved.modelSelection.effective).toEqual(effective);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 60000);

  it("rolls back effective metadata if the final configuration checkpoint rejects", async () => {
    const h = await createRpcHarness();
    let saved: any;
    try {
      await h.run({
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      });
      const original = saved.modelConfiguration;
      let reject = true;
      await expect(
        h.run({
          runId: "failed-checkpoint",
          sourceMessageId: "next",
          model: { ...h.request.model, id: "next-model" },
          session: {
            restore: saved,
            save: async (value: any) => {
              if (
                reject &&
                value.modelSelection.status === "applied" &&
                value.modelSelection.requested.modelId === "next-model"
              ) {
                reject = false;
                throw new Error("Offline checkpoint failure");
              }
              saved = value;
            },
          },
        }),
      ).rejects.toThrow("Model change failed");
      expect(saved.modelConfiguration).toEqual(original);
      expect(saved.modelSelection).toMatchObject({
        status: "failed",
        effective: { modelId: "offline-model" },
      });
      expect(h.requests).toHaveLength(1);
      expect(
        saved.entries.filter((entry: any) => entry.type === "model_change").at(-1).modelId,
      ).toBe("offline-model");
    } finally {
      await h.close();
    }
  }, 60000);

  it("commits a real deterministic summary using target metadata before the next normal inference", async () => {
    const protocol = observer();
    const h = await createRpcHarness({ wrapHost: protocol.wrapHost, estimateUsage: true });
    let saved: any;
    const session = () => ({
      restore: saved,
      save: async (value: unknown) => {
        saved = value;
      },
    });
    try {
      await h.run({ session: session() });
      // Import synthetic history without an earlier automatic compaction consuming the test window.
      const manager = SessionManager.inMemory("/work", undefined, [saved.header, ...saved.entries]);
      manager.appendMessage({
        role: "user",
        content: "Original goal " + "old detail ".repeat(16000),
        timestamp: 1,
      });
      manager.appendMessage({
        role: "user",
        content: "Recent task " + "recent ".repeat(16000),
        timestamp: 2,
      });
      saved = {
        ...saved,
        entries: manager.getEntries(),
        leafId: manager.getLeafId(),
        modelConfiguration: {
          ...saved.modelConfiguration,
          model: { ...saved.modelConfiguration.model, contextWindow: 200000 },
        },
      };
      const original = saved.entries.find(
        (entry: any) => entry.type === "message" && entry.message.role === "user",
      );
      protocol.commands.length = 0;
      const priorEntries = saved.entries.length;
      const history = saved.entries.filter((entry: any) => entry.type === "message");
      await h.run({
        runId: "switch-summary",
        sourceMessageId: "new-source",
        model: { ...h.request.model, id: "summary-target", reasoning: true, thinkingLevel: "high" },
        session: session(),
      });
      expect(protocol.commands.map((command) => command.type)).toEqual([
        "get_state",
        "compact",
        "set_model",
        "set_thinking_level",
        "get_state",
        "prompt",
      ]);
      const entries = saved.entries.slice(priorEntries);
      const index = entries.findIndex((entry: any) => entry.type === "compaction");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(entries[index]).toMatchObject({ details: { compactor: "fabric", version: 2 } });
      expect(
        entries
          .slice(0, index)
          .filter((entry: any) => entry.type === "model_change")
          .at(-1),
      ).toMatchObject({ modelId: "summary-target" });
      expect(saved.entries.find((entry: any) => entry.id === original.id)).toEqual(original);
      expect(saved.modelSelection).toMatchObject({
        status: "applied",
        effective: { modelId: "summary-target", thinkingLevel: "high" },
      });
      expect(h.requests).toHaveLength(2);
      expect(h.requests.at(-1)).toMatchObject({
        model: "summary-target",
        reasoning_effort: "high",
      });
      expect(saved.modelConfiguration.model.contextWindow).toBe(32768);
      expect(JSON.stringify(h.requests.at(-1)?.messages).length / 4).toBeLessThan(16384);
      expect(
        saved.entries.filter((entry: any) => history.some((source: any) => source.id === entry.id)),
      ).toEqual(history);
    } finally {
      await h.close();
    }
  }, 60000);

  it("preserves configuration and retries when the SDK mislabels an oversized first turn as too small", async () => {
    const protocol = observer();
    const h = await createRpcHarness({ wrapHost: protocol.wrapHost, estimateUsage: true });
    let saved: any;
    try {
      await h.run({
        prompt: "Original goal " + "old detail ".repeat(16000),
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      });
      const original = saved.entries.find(
        (entry: any) => entry.type === "message" && entry.message.role === "user",
      );

      protocol.commands.length = 0;
      const effective = saved.modelSelection.effective;
      await expect(
        h.run({
          runId: "switch-large",
          sourceMessageId: "new-source",
          model: { ...h.request.model, id: "next-large" },
          session: {
            restore: saved,
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ).rejects.toThrow("Model change failed");
      expect(protocol.commands.map((c) => c.type)).toEqual(["get_state", "compact"]);
      expect(saved.entries.find((entry: any) => entry.id === original.id)).toEqual(original);
      expect(saved.modelSelection).toMatchObject({
        effective,
        status: "failed",
        requested: { modelId: "next-large" },
      });
      expect(h.requests).toHaveLength(1);
      protocol.commands.length = 0;
      await expect(
        h.run({
          runId: "retry-large",
          sourceMessageId: "new-source",
          model: { ...h.request.model, id: "next-large" },
          session: {
            restore: saved,
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ).rejects.toThrow("Model change failed");
      expect(protocol.commands.map((c) => c.type)).toEqual(["get_state", "compact"]);
      expect(saved.modelSelection).toMatchObject({ effective, status: "failed" });
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 60000);

  it("rejects compact/model/effort commands during a real tool without changing configuration", async () => {
    const protocol = observer();
    const h = await createRpcHarness({
      wrapHost: protocol.wrapHost,
      tool: { name: "read_file", args: { path: "notes.txt" } },
    });
    let saved: any;
    let calls = 0;
    try {
      await h.run({
        model: { ...h.request.model, reasoning: true, thinkingLevel: "low" },
        tools: [
          {
            name: "read_file",
            description: "Read",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        session: {
          save: async (value) => {
            saved = value;
          },
        },
        executeTool: async () => {
          calls++;
          for (const command of [
            { type: "compact" },
            { type: "set_model", provider: "rakazo-broker", modelId: "offline-model" },
            { type: "set_thinking_level", level: "high" },
          ])
            expect(await protocol.probe(command)).toMatchObject({
              success: false,
              command: command.type,
            });
          return { text: "tool completed" };
        },
      });
      expect(calls).toBe(1);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.every((request) => request.reasoning_effort === "low")).toBe(true);
      expect(saved.modelSelection).toMatchObject({
        status: "applied",
        effective: { modelId: "offline-model", thinkingLevel: "low" },
      });
      expect(saved.entries.some((entry: any) => entry.type === "compaction")).toBe(false);
      expect(JSON.stringify(saved)).toContain("toolResult");
    } finally {
      await h.close();
    }
  }, 60000);

  it("switches a restored model and reasoning before prompt; no-op avoids compaction; failed compact preserves history and retries", async () => {
    const protocol = observer();
    const h = await createRpcHarness({ wrapHost: protocol.wrapHost });
    let saved: any;
    const session = () => ({
      restore: saved,
      save: async (value: unknown) => {
        saved = value;
      },
    });
    try {
      await h.run({
        model: { ...h.request.model, reasoning: true, thinkingLevel: "low" },
        session: session(),
      });
      const original = saved;
      protocol.commands.length = 0;
      const model = {
        ...h.request.model,
        id: "offline-next",
        reasoning: true,
        thinkingLevel: "high" as const,
      };
      protocol.fail(true);
      await expect(
        h.run({ runId: "second", sourceMessageId: "second-message", model, session: session() }),
      ).rejects.toThrow("Model change failed");
      expect(protocol.commands.map((c) => c.type)).toEqual(["get_state", "compact"]);
      expect(saved.modelSelection).toMatchObject({
        status: "failed",
        effective: original.modelSelection.effective,
        requested: { modelId: "offline-next" },
      });
      expect(saved.modelConfiguration).toEqual(original.modelConfiguration);
      expect(saved.entries.filter((entry: any) => entry.type === "message")).toEqual(
        original.entries.filter((entry: any) => entry.type === "message"),
      );
      expect(h.requests).toHaveLength(1);
      protocol.fail(false);
      protocol.commands.length = 0;
      await h.run({ runId: "retry", sourceMessageId: "second-message", model, session: session() });
      expect(protocol.commands.map((c) => c.type)).toEqual([
        "get_state",
        "compact",
        "set_model",
        "set_thinking_level",
        "get_state",
        "prompt",
      ]);
      expect(h.requests.at(-1)).toMatchObject({ model: "offline-next", reasoning_effort: "high" });
      expect(saved.modelSelection).toMatchObject({
        status: "applied",
        effective: { modelId: "offline-next", thinkingLevel: "high" },
      });
      expect(
        saved.entries.some(
          (entry: any) =>
            entry.id === original.entries.find((entry: any) => entry.type === "message").id,
        ),
      ).toBe(true);
      protocol.commands.length = 0;
      await h.run({ runId: "unchanged", sourceMessageId: "third", model, session: session() });
      expect(protocol.commands.map((c) => c.type)).toEqual(["get_state", "prompt"]);
      protocol.commands.length = 0;
      await h.run({
        runId: "effort",
        sourceMessageId: "fourth",
        model: { ...model, thinkingLevel: "low" },
        session: session(),
      });
      expect(protocol.commands.map((c) => c.type)).toEqual([
        "get_state",
        "compact",
        "set_model",
        "set_thinking_level",
        "get_state",
        "prompt",
      ]);
      expect(h.requests.at(-1)?.reasoning_effort).toBe("low");
      expect(h.host.reaped).toBe(h.host.starts);
      expect(JSON.stringify(saved)).not.toContain("fake-backend-key");
    } finally {
      await h.close();
    }
  }, 60000);

  it("keeps a worker model binding on its persisted identity after every parent/child process stops", async () => {
    const protocol = observer();
    const h = await createRpcHarness({
      runTimeoutMs: 60_000,
      wrapHost: protocol.wrapHost,
      tool: { name: "run_subagent", args: { name: "helper", task: "Help" } },
    });
    let saved: any;
    const identities: string[] = [];
    let modelId: string | undefined = "worker-one";
    const resolveParticipantModel = async (id: string) => {
      identities.push(id);
      return modelId
        ? { ...h.request.model, id: modelId, reasoning: true, thinkingLevel: "high" as const }
        : undefined;
    };
    try {
      await h.run({
        tools: [PRIVATE_SUBAGENT_TOOL],
        executeTool: async () => ({ ok: true }),
        resolveParticipantModel,
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      });
      const child = children(saved)[0] as any;
      expect(child.checkpoint.session.modelSelection.effective.modelId).toBe("worker-one");
      expect(h.host.reaped).toBe(2);
      modelId = "worker-two";
      protocol.commands.length = 0;
      let delivered = false;
      await h.run({
        runId: "new-parent",
        prompt: "",
        queueOnly: true,
        tools: [PRIVATE_SUBAGENT_TOOL],
        executeTool: async () => ({ ok: true }),
        resolveParticipantModel,
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || delivered) return;
          delivered = true;
          await control.deliver({
            id: "resume-worker",
            messageId: "resume-worker",
            participantId: child.id,
            text: "Continue worker",
          });
        },
      });
      expect(identities).toEqual([child.id, child.id]);
      expect(childRecord(saved, child.id).checkpoint.session.modelSelection.effective.modelId).toBe(
        "worker-two",
      );
      expect(h.requests.at(-1)).toMatchObject({ model: "worker-two", reasoning_effort: "high" });
      const childCommands = protocol.commands
        .filter((command) => command.type !== "get_state")
        .map((command) => command.type);
      expect(childCommands).toEqual(["compact", "set_model", "set_thinking_level", "prompt"]);
      expect(h.host.reaped).toBe(4);
      modelId = undefined;
      protocol.commands.length = 0;
      delivered = false;
      await h.run({
        runId: "reset-parent",
        prompt: "",
        queueOnly: true,
        tools: [PRIVATE_SUBAGENT_TOOL],
        executeTool: async () => ({ ok: true }),
        resolveParticipantModel,
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || delivered) return;
          delivered = true;
          await control.deliver({
            id: "reset-worker",
            messageId: "reset-worker",
            participantId: child.id,
            text: "Continue with bot model",
          });
        },
      });
      expect(identities).toEqual([child.id, child.id, child.id]);
      expect(childRecord(saved, child.id).checkpoint.session.modelSelection.effective).toEqual({
        provider: h.request.model.provider,
        modelId: h.request.model.id,
        thinkingLevel: "off",
      });
      expect(h.requests.at(-1)?.model).toBe(h.request.model.id);
      expect(
        protocol.commands
          .filter((command) => command.type !== "get_state")
          .map((command) => command.type),
      ).toEqual(["compact", "set_model", "set_thinking_level", "prompt"]);
      expect(h.host.reaped).toBe(6);
    } finally {
      await h.close();
    }
  }, 120000);
});
