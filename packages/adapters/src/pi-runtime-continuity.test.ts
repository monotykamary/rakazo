import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { boundedExecutionEvidence } from "./pi-execution-evidence.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

const children = (state: any): any[] =>
  state?.agents?.records.map((entry: any) => entry.record) ?? [];
const childRecord = (state: any, id: string) => children(state).find((child) => child.id === id);

const read = {
  name: "read_file",
  description: "Read",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
describe("managed runtime continuity", () => {
  it("acknowledges a durable empty-prompt queue wake while its model stream is still open", async () => {
    const harness = await createRpcHarness({ quiet: true });
    let saved: unknown;
    let sent = false;
    let acknowledged = false;
    try {
      const work = harness.run({
        prompt: "",
        sourceMessageId: undefined,
        queueOnly: true,
        session: {
          save: async (state) => {
            saved = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || sent) return;
          sent = true;
          await control.deliver({
            id: "queued",
            messageId: "queue:queued",
            text: "Queued durable marker",
          });
          expect(JSON.stringify(saved)).toContain("Queued durable marker");
          expect(JSON.stringify(saved)).toContain("queue:queued");
          acknowledged = true;
        },
      });
      await expect.poll(() => acknowledged, { timeout: 15000 }).toBe(true);
      await expect.poll(() => harness.requests.length, { timeout: 5000 }).toBe(1);
      const aborted = expect(work).rejects.toThrow("AbortError");
      await harness.runtime.abort("run");
      await aborted;
      expect(harness.host.reaped).toBe(1);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("persists a child transcript and resumes it with placement after the root run changes", async () => {
    const harness = await createRpcHarness({
      runTimeoutMs: 60_000,
      tool: {
        name: "run_subagent",
        args: { name: "helper", task: "Child original marker", cwd: "project", worktree: false },
      },
    });
    let saved: any;
    const authorized = vi.fn(async (placement: { cwd?: string; worktreeId?: string }) => ({
      placement: { cwd: placement.cwd!, worktreeId: placement.worktreeId },
      executeTool: async () => ({ ok: true }),
    }));
    try {
      await harness.run({
        currentTurnImages: [
          { name: "root.png", mimeType: "image/png", data: Buffer.from("root-only-image-fixture") },
        ],
        tools: builtinAgentTools.filter((tool) =>
          ["run_subagent", "manage_queue"].includes(tool.name),
        ),
        executeTool: async () => ({ ok: true }),
        authorizeSubagentPlacement: authorized,
        session: {
          save: async (state) => {
            saved = state;
          },
        },
      });
      const id = children(saved)[0]!.id;
      expect(id).toBeTruthy();
      const helperReply = harness.requests
        .at(-1)!
        .messages.findLast((message: { role: string }) => message.role === "tool");
      expect(String(helperReply?.content)).toContain(id);
      expect(String(helperReply?.content)).toContain("completed");
      expect(JSON.stringify(childRecord(saved, id).checkpoint.session)).toContain(
        "Child original marker",
      );
      expect(childRecord(saved, id).checkpoint.placement.cwd).toBe("project");
      expect(JSON.stringify(childRecord(saved, id).checkpoint.session)).not.toContain(
        Buffer.from("root-only-image-fixture").toString("base64"),
      );
      let sent = false;
      await harness.run({
        runId: "run-next",
        prompt: "",
        sourceMessageId: undefined,
        queueOnly: true,
        tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        executeTool: async () => ({ ok: true }),
        authorizeSubagentPlacement: authorized,
        session: {
          restore: saved,
          save: async (state) => {
            saved = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || sent || control.participantId !== "run-next") return;
          sent = true;
          await control.deliver({
            id: "targeted",
            messageId: "targeted",
            participantId: id,
            text: "Child continuation marker",
            images: [
              {
                name: "fixture.png",
                mimeType: "image/png",
                data: Buffer.from("offline-image-fixture"),
              },
            ],
          });
        },
      });
      expect(JSON.stringify(childRecord(saved, id).checkpoint.session)).toContain(
        "Child original marker",
      );
      expect(JSON.stringify(childRecord(saved, id).checkpoint.session)).toContain(
        "Child continuation marker",
      );
      expect(childRecord(saved, id).parentId).toBe("run-next");
      expect(childRecord(saved, id).checkpoint.session.sourceMessageIds).toContain("targeted");
      expect(JSON.stringify(childRecord(saved, id).checkpoint.session)).toContain(
        Buffer.from("offline-image-fixture").toString("base64"),
      );
      expect(authorized).toHaveBeenCalledTimes(2);
      expect(harness.host.reaped).toBe(4);
    } finally {
      await harness.close();
    }
  }, 120000);

  it("polls the root queue at a live child model boundary and delivers only to that child", async () => {
    const harness = await createRpcHarness({
      runTimeoutMs: 60_000,
      tool: {
        name: "run_subagent",
        args: { name: "helper", task: "Child task", cwd: "project", worktree: false },
      },
    });
    let saved: any;
    let delivered = false;
    const scopes = new Set<string>();
    const trace: unknown[] = [];
    try {
      await harness.run({
        tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        executeTool: async () => ({ ok: true }),
        authorizeSubagentPlacement: async () => ({
          placement: { cwd: "project" },
          executeTool: async () => ({ ok: true }),
        }),
        session: {
          save: async (state) => {
            saved = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          scopes.add(control.participantId);
          trace.push({
            boundary,
            statuses: children(saved).map((value: any) => value.status),
          });
          const child = children(saved).find((value: any) => value.status === "running") as any;
          if (boundary !== "before_model" || delivered || !child) return;
          delivered = true;
          await control.deliver({
            id: "child-steering",
            messageId: "queue:child-steering",
            participantId: child.id,
            text: "Targeted child-only marker",
          });
        },
      });
      expect(delivered, JSON.stringify(trace)).toBe(true);
      expect([...scopes]).toEqual(["run"]);
      const child = children(saved)[0] as any;
      expect(JSON.stringify(child.checkpoint.session)).toContain("Targeted child-only marker");
      const rootRequests = harness.requests.filter(
        (request) => !JSON.stringify(request.messages).includes("Complete the delegated task."),
      );
      expect(
        rootRequests.some((request) =>
          JSON.stringify(request.messages).includes("Targeted child-only marker"),
        ),
      ).toBe(false);
      expect(child.checkpoint.placement.cwd).toBe("project");
      expect(harness.host.reaped).toBe(2);
    } finally {
      await harness.close();
    }
  }, 120000);

  it("parks a participant gate at that child's model boundary without deadlocking its completion", async () => {
    const harness = await createRpcHarness({
      tool: {
        name: "run_subagent",
        args: { name: "helper", task: "Gate child task", worktree: false },
      },
    });
    let saved: any;
    let awaited = false;
    let completed = false;
    try {
      await harness.run({
        tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        executeTool: async () => ({ ok: true }),
        session: {
          save: async (state) => {
            saved = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          const child = children(saved).find((value: any) => value.status === "running") as any;
          if (boundary !== "before_model" || awaited || !child) return;
          awaited = true;
          const result = await control.command(
            { kind: "participant-await", participantId: child.id },
            { id: "gate", signal: AbortSignal.timeout(10000) },
          );
          expect(result).toEqual({ outcome: "completed" });
          expect(childRecord(saved, child.id).status).toBe("completed");
          completed = true;
        },
      });
      expect(awaited).toBe(true);
      expect(completed).toBe(true);
      expect(harness.host.reaped).toBe(2);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("acknowledges an idle compact command only after the real worker checkpoint", async () => {
    const harness = await createRpcHarness();
    let saved: unknown;
    let saves = 0;
    let commanded = false;
    try {
      await harness.run({
        session: {
          save: async (state) => {
            saved = state;
          },
        },
      });
      const modelsBefore = harness.requests.length;
      await harness.run({
        runId: "compact-run",
        prompt: "",
        queueOnly: true,
        session: {
          restore: saved,
          save: async (state) => {
            saved = state;
            saves++;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || commanded) return;
          commanded = true;
          const result = await control.command(
            { kind: "compact" },
            { id: "compact-command", signal: AbortSignal.timeout(10000) },
          );
          expect(result).toEqual({ outcome: "completed" });
          expect(saves).toBeGreaterThan(0);
        },
      });
      expect(commanded).toBe(true);
      expect(harness.requests).toHaveLength(modelsBefore);
      expect(harness.host.reaped).toBe(2);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("retains real Fabric code, result and rich audit evidence", async () => {
    const code = 'return await pi.read({path: "notes.txt"});';
    const harness = await createRpcHarness({ tool: { name: "fabric_exec", args: { code } } });
    try {
      const events = await harness.run({
        tools: [read],
        executeTool: async () => ({ text: "inspector evidence marker" }),
      });
      const evidence = events.filter(
        (event) => event.type === "execution" && event.name === "fabric_exec",
      );
      expect(evidence).toContainEqual(expect.objectContaining({ code, status: "started" }));
      expect(evidence).toContainEqual(
        expect.objectContaining({
          status: "completed",
          details: expect.any(Object),
          output: expect.any(Array),
        }),
      );
      expect(JSON.stringify(evidence)).toContain("inspector evidence marker");
    } finally {
      await harness.close();
    }
  }, 30000);

  it("pauses at the initial actual model boundary without making a model request", async () => {
    const harness = await createRpcHarness();
    let boundaries = 0;
    let checkpoint: unknown;
    try {
      const events = await harness.run({
        session: {
          save: async (state) => {
            checkpoint = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary === "before_model" && ++boundaries === 1) await control.pause();
        },
      });
      expect(boundaries).toBe(1);
      expect(harness.requests).toHaveLength(0);
      expect(harness.host.reaped).toBe(1);
      expect(checkpoint).toBeDefined();
      expect(events).toContainEqual(
        expect.objectContaining({ type: "runtime_activity", activity: "queue", status: "paused" }),
      );
      expect(events.at(-1)).toEqual({ type: "done" });
      expect(events.some((event) => event.type === "text")).toBe(false);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("continues an interrupted root only after a new explicit resume intent", async () => {
    const harness = await createRpcHarness();
    let saved: unknown;
    try {
      await harness.run({
        prompt: "Original paused task marker",
        session: {
          save: async (state) => {
            saved = state;
          },
        },
        runtimeBoundary: async (boundary, control) => {
          if (boundary === "before_model") await control.pause();
        },
      });
      expect(harness.requests).toHaveLength(0);
      const restoredIds = [
        ...(saved as { sourceMessageIds: string[] }).sourceMessageIds,
        ...Array.from({ length: 2048 }, (_, i) => `retained-message-${i}`),
        "retained-message-0",
      ];
      saved = { ...(saved as object), sourceMessageIds: restoredIds };
      await harness.run({
        runId: "quiet-wake",
        queueOnly: true,
        prompt: "",
        sourceMessageId: undefined,
        session: {
          restore: saved,
          save: async (state) => {
            saved = state;
          },
        },
      });
      expect(harness.requests).toHaveLength(0);
      const sourceMessageId = "queue-resume:fixture-queue:explicit-request";
      await harness.run({
        runId: "resumed-run",
        prompt: "Continue the paused task.",
        sourceMessageId,
        session: {
          restore: saved,
          save: async (state) => {
            saved = state;
          },
        },
      });
      expect(harness.requests).toHaveLength(1);
      expect(JSON.stringify(harness.requests[0])).toContain("Original paused task marker");
      expect(JSON.stringify(harness.requests[0])).toContain("Continue the paused task.");
      expect(saved).toMatchObject({ sourceMessageIds: expect.arrayContaining([sourceMessageId]) });
      const checkpointIds = (saved as { sourceMessageIds: string[] }).sourceMessageIds;
      expect(Array.isArray(checkpointIds)).toBe(true);
      expect(checkpointIds).toEqual([...new Set([...restoredIds, sourceMessageId])]);
      expect(harness.host.reaped).toBe(3);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("latches a requested graceful pause before an authorized tool effect", async () => {
    const harness = await createRpcHarness({
      runTimeoutMs: 60_000,
      tool: { name: "read_file", args: { path: "notes.txt" } },
    });
    const executeTool = vi.fn(async () => ({ ok: true }));
    let checkpoint: unknown;
    try {
      const events = await harness.run({
        tools: [read],
        executeTool,
        assertActive: async (boundary) => (boundary?.effects ? "pause" : undefined),
        session: {
          save: async (state) => {
            checkpoint = state;
          },
        },
      });
      expect(executeTool).not.toHaveBeenCalled();
      expect(harness.requests).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "execution", status: "paused" }),
      );
      expect(JSON.stringify(checkpoint)).toContain('"queue":"paused"');
    } finally {
      await harness.close();
    }
  }, 120000);

  it("does not dispatch the settled queue tail after a terminal worker model failure", async () => {
    const harness = await createRpcHarness({ error: true });
    const boundaries: string[] = [];
    let checkpoint: unknown;
    try {
      await expect(
        harness.run({
          session: {
            save: async (state) => {
              checkpoint = state;
            },
          },
          runtimeBoundary: async (boundary) => {
            boundaries.push(boundary);
          },
        }),
      ).rejects.toThrow();
      expect(boundaries).not.toContain("settled");
      expect(boundaries.filter((boundary) => boundary === "idle")).toHaveLength(1);
      expect(boundaries).toContain("paused");
      expect(checkpoint).toBeDefined();
      expect(harness.requests).toHaveLength(1);
      expect(harness.host.reaped).toBe(1);
    } finally {
      await harness.close();
    }
  }, 30000);

  it("omits oversized whole strings without breaking later exact secret redaction", () => {
    const evidence = boundedExecutionEvidence(
      {
        parentExecutionId: "parent",
        operationAddress: "calls/1",
        output: "x".repeat(10000),
        details: { audit: "retained" },
      },
      256,
    );
    expect(evidence.truncated).toBe(true);
    expect(evidence.value).toEqual({
      parentExecutionId: "parent",
      operationAddress: "calls/1",
      output: undefined,
      details: { audit: "retained" },
    });
    expect(Buffer.byteLength(JSON.stringify(evidence.value))).toBeLessThanOrEqual(256);
  });
});
