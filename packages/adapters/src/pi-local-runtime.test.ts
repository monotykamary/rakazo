import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPiRuntime } from "./pi-local-runtime.js";
import {
  readLocalPiEmulatorLog,
  writeLocalPiEmulator,
  writeLocalPiScenario,
} from "./pi-local-runtime-test-helper.js";
import { deliverPremoveDrain } from "./premove-drain.js";

async function collect(
  runtime: LocalPiRuntime,
  request: AgentRunRequest,
  signal = AbortSignal.timeout(10_000),
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(request, { signal })) events.push(event);
  return events;
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    sourceMessageId: "source",
    prompt: "Current prompt",
    instructions: "Follow the bot policy.",
    history: [],
    tools: [],
    model: { provider: "pi-local", id: "default" },
    ...overrides,
  };
}

function commands(log: Array<Record<string, unknown>>, type: string) {
  return log
    .filter((entry) => entry.type === "command")
    .map((entry) => entry.command as Record<string, unknown>)
    .filter((command) => command.type === type);
}

async function waitFor(condition: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for emulator");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("LocalPiRuntime", () => {
  let root: string;
  let cwd: string;
  let sessionDir: string;
  let command: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rakazo-local-pi-test-"));
    cwd = join(root, "workspace");
    sessionDir = join(root, "sessions");
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]),
    );
    command = await writeLocalPiEmulator(cwd);
    await writeLocalPiScenario(cwd, {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("uses isolated owned sessions, preserves normal Pi config, strips parent session metadata, and frames on LF only", async () => {
    vi.stubEnv("PI_SESSION_ID", "active-terminal");
    vi.stubEnv("PI_SESSION_FILE", "/not/the/runtime/session.jsonl");
    vi.stubEnv("PI_PROVIDER", "parent-provider");
    vi.stubEnv("PI_MODEL", "parent-model");
    vi.stubEnv("PI_REASONING_LEVEL", "high");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "normal-pi-config"));
    await writeLocalPiScenario(cwd, { textChunks: ["one\u2028two", "\nthree"] });

    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    expect(runtime.describe()).toMatchObject({ id: "pi-local", capabilities: { streaming: true } });
    const first = request({
      history: [{ role: "user", content: "Prior product history" }],
      session: {
        save: async (value) => {
          saved = value;
        },
      },
    });
    const events = await collect(runtime, first);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("one\u2028two\nthree");

    let log = await readLocalPiEmulatorLog(cwd);
    const start = log.find((entry) => entry.type === "start")!;
    const argv = start.args as string[];
    expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(argv).toContain("--session");
    expect(argv).toContain("--extension");
    expect(argv).not.toContain("--approve");
    expect(argv).not.toContain("--no-extensions");
    expect(argv).not.toContain("--no-skills");
    expect(argv).not.toContain("--config");
    expect(start.metadata).toEqual({});
    expect(commands(log, "set_model")).toHaveLength(0);
    expect(String(commands(log, "prompt")[0]?.message)).toContain("Prior product history");

    const second = request({
      runId: "run-two",
      sourceMessageId: "source-two",
      prompt: "Second prompt",
      history: [{ role: "user", content: "Prior product history" }],
      session: {
        restore: saved,
        save: async (value) => {
          saved = value;
        },
      },
    });
    await collect(runtime, second);
    log = await readLocalPiEmulatorLog(cwd);
    const starts = log.filter((entry) => entry.type === "start");
    const firstSession = (starts[0]!.args as string[])[3];
    const secondSession = (starts[1]!.args as string[])[3];
    expect(secondSession).toBe(firstSession);
    const prompts = commands(log, "prompt");
    expect(String(prompts[1]?.message)).toContain("Second prompt");
    expect(String(prompts[1]?.message)).not.toContain("Prior product history");
  });

  it("uses Pi set_model for an explicit selection without Rakazo visibility policy", async () => {
    const allowed = vi.fn(async () => undefined);
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await collect(
      runtime,
      request({
        model: { provider: "anthropic", id: "configured-model", thinkingLevel: "high" },
        assertModelAllowed: allowed,
      }),
    );
    const log = await readLocalPiEmulatorLog(cwd);
    expect(commands(log, "set_model")).toEqual([
      expect.objectContaining({ provider: "anthropic", modelId: "configured-model" }),
    ]);
    expect(commands(log, "set_thinking_level")).toEqual([
      expect.objectContaining({ level: "high" }),
    ]);
    expect(allowed).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checkpoints Pi state acknowledgment for explicit selection: %s",
    async (explicit) => {
      const checkpoints: unknown[] = [];
      await collect(
        new LocalPiRuntime({ command, cwd, sessionDir }),
        request({
          ...(explicit
            ? { model: { provider: "offline", id: "selected", thinkingLevel: "high" as const } }
            : {}),
          session: {
            save: async (value) => {
              checkpoints.push(structuredClone(value));
            },
          },
        }),
      );
      expect(checkpoints).toContainEqual(
        expect.objectContaining({
          modelSelection: {
            requested: explicit
              ? { provider: "offline", modelId: "selected", thinkingLevel: "high" }
              : null,
            effective: {
              provider: "offline",
              modelId: explicit ? "selected" : "offline-model",
              thinkingLevel: explicit ? "high" : "medium",
            },
            status: "applied",
            error: null,
          },
        }),
      );
    },
  );

  it("records failed state acknowledgment and never prompts with an unacknowledged model", async () => {
    await writeLocalPiScenario(cwd, { ignoreModelSelection: true });
    let saved: unknown;
    await expect(
      collect(
        new LocalPiRuntime({ command, cwd, sessionDir }),
        request({
          model: { provider: "offline", id: "selected" },
          session: {
            save: async (value) => {
              saved = structuredClone(value);
            },
          },
        }),
      ),
    ).rejects.toThrow("did not acknowledge");
    expect(saved).toMatchObject({
      modelSelection: {
        requested: { provider: "offline", modelId: "selected", thinkingLevel: null },
        effective: null,
        status: "failed",
        error: "Model change was not acknowledged by Pi",
      },
    });
    expect(commands(await readLocalPiEmulatorLog(cwd), "prompt")).toHaveLength(0);
  });

  it("forwards product tools and exposes bounded tool code, output, details, and usage", async () => {
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result" as const,
      content: [{ type: "text" as const, text: "attached" }],
      details: { nestedCalls: [{ name: "storage.put" }], source: "product" },
    }));
    await writeLocalPiScenario(cwd, {
      tool: { name: "attach_file", args: { path: "report.txt" } },
    });
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const events = await collect(
      runtime,
      request({
        tools: [
          {
            name: "attach_file",
            description: "Attach a workspace file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
            route: { connectorId: "files", toolName: "attach" },
          },
        ],
        executeTool,
      }),
    );
    expect(executeTool).toHaveBeenCalledWith(
      "attach_file",
      { path: "report.txt" },
      "run:tool-call-1",
      { connectorId: "files", toolName: "attach" },
      expect.any(AbortSignal),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        name: "attach_file",
        executionId: "run:tool-call-1",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "execution",
        name: "attach_file",
        status: "completed",
        output: [{ type: "text", text: "attached" }],
        details: expect.objectContaining({ nestedCalls: [{ name: "storage.put" }] }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        inputTokens: 5,
        outputTokens: 2,
        provider: "offline",
        model: "offline-model",
      }),
    );

    await writeLocalPiScenario(cwd, {
      tool: {
        name: "fabric_exec",
        args: { code: "return await tools.call({ ref: 'pi.read', args: { path: 'x' } })" },
        result: {
          content: [{ type: "text", text: "fabric output" }],
          details: { nestedCalls: [{ ref: "pi.read" }], source: "fabric" },
        },
      },
    });
    const fabricEvents = await collect(
      runtime,
      request({ runId: "fabric-run", sourceMessageId: "fabric" }),
    );
    expect(fabricEvents).toContainEqual(
      expect.objectContaining({
        type: "execution",
        name: "fabric_exec",
        status: "completed",
        code: expect.stringContaining("tools.call"),
        output: [{ type: "text", text: "fabric output" }],
        details: expect.objectContaining({ nestedCalls: [{ ref: "pi.read" }] }),
      }),
    );
  });

  it("cancels blocking extension dialogs instead of hanging", async () => {
    await writeLocalPiScenario(cwd, {
      startupUiMethod: "input",
      uiMethod: "confirm",
      textChunks: ["after cancel"],
    });
    const events = await collect(new LocalPiRuntime({ command, cwd, sessionDir }), request());
    expect(events).toContainEqual({ type: "done", text: "after cancel" });
    const responses = (await readLocalPiEmulatorLog(cwd)).filter(
      (entry) => entry.type === "ui_response",
    );
    expect(responses).toHaveLength(2);
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.objectContaining({
            type: "extension_ui_response",
            id: "startup-ui",
            cancelled: true,
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "extension_ui_response",
            id: "ui-1",
            cancelled: true,
          }),
        }),
      ]),
    );
  });

  it("aborts the owned process, clears its lock, and can continue the same durable session", async () => {
    await writeLocalPiScenario(cwd, { waitForAbort: true });
    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const firstRequest = request({
      session: {
        save: async (value) => {
          saved = value;
        },
      },
    });
    const running = collect(runtime, firstRequest, AbortSignal.timeout(20_000));
    await waitFor(async () => commands(await readLocalPiEmulatorLog(cwd), "prompt").length === 1);
    await runtime.abort(firstRequest.runId);
    await expect(running).rejects.toThrow(/aborted|closed|agent_settled/i);
    await waitFor(async () =>
      (await readLocalPiEmulatorLog(cwd)).some((entry) => entry.type === "end"),
    );

    await writeLocalPiScenario(cwd, { textChunks: ["continued"] });
    const events = await collect(
      runtime,
      request({
        runId: "continued-run",
        sourceMessageId: "source",
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    expect(events).toContainEqual({ type: "done", text: "continued" });
    const prompts = commands(await readLocalPiEmulatorLog(cwd), "prompt");
    expect(String(prompts.at(-1)?.message)).toContain("Continue the interrupted request");
  });

  it("cleans up after CLI failure so a checkpoint can be retried", async () => {
    await writeLocalPiScenario(cwd, { exitOnPrompt: true });
    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(
        runtime,
        request({
          session: {
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ),
    ).rejects.toThrow(/exited|disconnected/);

    await writeLocalPiScenario(cwd, { textChunks: ["recovered"] });
    const recovered = await collect(
      runtime,
      request({
        runId: "retry-run",
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    expect(recovered).toContainEqual({ type: "done", text: "recovered" });
  });

  it("starts a new generation when clear removes restore state or restore ownership mismatches", async () => {
    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await collect(
      runtime,
      request({
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    let starts = (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start");
    const original = (starts[0]!.args as string[])[3];

    await collect(
      runtime,
      request({
        runId: "after-clear",
        sourceMessageId: "after-clear",
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    starts = (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start");
    const afterClear = (starts[1]!.args as string[])[3];
    expect(afterClear).not.toBe(original);

    const mismatched = { ...(saved as Record<string, unknown>), cwdHash: "0".repeat(24) };
    await expect(
      collect(
        runtime,
        request({
          runId: "mismatch",
          sourceMessageId: "mismatch",
          session: { restore: mismatched, save: async () => undefined },
        }),
      ),
    ).rejects.toThrow("checkpoint ownership");
    starts = (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start");
    expect(starts).toHaveLength(2);
  });

  it("fences concurrent owners of the same bot/thread session", async () => {
    let saved: unknown;
    const seed = new LocalPiRuntime({ command, cwd, sessionDir });
    await collect(
      seed,
      request({
        session: {
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    await writeLocalPiScenario(cwd, { waitForAbort: true });

    const first = new LocalPiRuntime({ command, cwd, sessionDir });
    const firstRequest = request({
      runId: "owner-one",
      sourceMessageId: "owner-one",
      session: {
        restore: saved,
        save: async (value) => {
          saved = value;
        },
      },
    });
    const firstRun = collect(first, firstRequest, AbortSignal.timeout(20_000));
    await waitFor(async () => commands(await readLocalPiEmulatorLog(cwd), "prompt").length >= 2);
    const second = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(
        second,
        request({
          runId: "owner-two",
          sourceMessageId: "owner-two",
          session: { restore: saved, save: async () => undefined },
        }),
      ),
    ).rejects.toThrow("ownership lock");
    await first.abort(firstRequest.runId);
    await firstRun.catch(() => undefined);
  });

  it("does not unlink a replacement session lock during cleanup", async () => {
    await writeLocalPiScenario(cwd, { waitForAbort: true });
    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const runRequest = request({
      session: {
        save: async (value) => {
          saved = value;
        },
      },
    });
    const running = collect(runtime, runRequest, AbortSignal.timeout(20_000));
    await waitFor(async () => commands(await readLocalPiEmulatorLog(cwd), "prompt").length === 1);
    const start = (await readLocalPiEmulatorLog(cwd)).find((entry) => entry.type === "start")!;
    const sessionFile = (start.args as string[])[3]!;
    const lock = sessionFile.replace(/\.jsonl$/, ".lock");
    await writeFile(lock, JSON.stringify({ token: "replacement-owner" }));
    await runtime.abort(runRequest.runId);
    await running.catch(() => undefined);
    await expect(readFile(lock, "utf8")).resolves.toContain("replacement-owner");
    expect(saved).toBeDefined();
  });

  it.each(["idle", "before_model"] as const)(
    "sends a drain at %s as one standard RPC prompt with all images",
    async (boundary) => {
      let delivered = false;
      const checkpoints: unknown[] = [];
      const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
      await collect(
        runtime,
        request({
          queueOnly: boundary === "idle",
          session: {
            save: async (value) => {
              checkpoints.push(structuredClone(value));
            },
          },
          runtimeBoundary: async (name, control) => {
            if (name !== boundary || delivered) return;
            delivered = true;
            await deliverPremoveDrain(
              [1, 2, 3].map((value) => ({
                id: `row-${value}`,
                messageId: `row-${value}`,
                text: `text-${value}`,
                images: [
                  {
                    name: `image-${value}`,
                    mimeType: "image/png" as const,
                    data: new Uint8Array([value]),
                  },
                ],
              })),
              "rpc",
              control,
            );
          },
        }),
      );
      expect(delivered).toBe(true);
      const log = await readLocalPiEmulatorLog(cwd);
      const prompts = commands(log, "prompt");
      const drains = prompts.filter((prompt) => String(prompt.message).includes("text-1"));
      expect(drains).toHaveLength(1);
      expect(drains[0]?.message).toContain("text-1\n\ntext-2\n\ntext-3");
      expect(drains[0]?.images).toEqual(
        ["AQ==", "Ag==", "Aw=="].map((data) => ({ type: "image", mimeType: "image/png", data })),
      );
      expect(drains[0]).not.toHaveProperty("content");
      expect(drains[0]?.streamingBehavior).toBe(boundary === "before_model" ? "steer" : undefined);
      expect(prompts).toHaveLength(boundary === "idle" ? 1 : 2);
      expect(commands(log, "abort")).toHaveLength(0);
      expect(
        checkpoints.some((checkpoint) => JSON.stringify(checkpoint).includes("queue-drain:rpc")),
      ).toBe(true);
    },
  );

  it("rejects queue delivery without a durable session before accepting intent", async () => {
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(
        runtime,
        request({
          queueOnly: true,
          runtimeBoundary: async (boundary, control) => {
            if (boundary === "idle")
              await control.deliver({
                id: "undurable-row",
                messageId: "undurable-message",
                text: "Do not lose this intent",
              });
          },
        }),
      ),
    ).rejects.toThrow("queue delivery requires a durable runtime session");
    expect(commands(await readLocalPiEmulatorLog(cwd), "prompt")).toHaveLength(0);
  });

  it("honors queue delivery and compaction but explicitly rejects participant waits", async () => {
    await writeLocalPiScenario(cwd, { textChunks: ["queued"] });
    let compactResult: unknown;
    let waitResult: unknown;
    let delivered = false;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const events = await collect(
      runtime,
      request({
        queueOnly: true,
        session: { save: async () => undefined },
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || delivered) return;
          delivered = true;
          compactResult = await control.command(
            { kind: "compact", instructions: "Keep decisions" },
            { id: "compact", signal: AbortSignal.timeout(2_000) },
          );
          waitResult = await control.command(
            { kind: "participant-await", participantId: "foreign" },
            { id: "await", signal: AbortSignal.timeout(2_000) },
          );
          await control.deliver({
            id: "queue-row",
            messageId: "queue-message",
            text: "Queued intent",
          });
        },
      }),
    );
    expect(compactResult).toEqual({ outcome: "completed" });
    expect(waitResult).toMatchObject({ outcome: "rejected" });
    expect(events).toContainEqual({ type: "done", text: "queued" });
    expect(String(commands(await readLocalPiEmulatorLog(cwd), "prompt")[0]?.message)).toContain(
      "Queued intent",
    );
  });

  it("fails provider terminal errors and projects only observed Fabric completion messages", async () => {
    await writeLocalPiScenario(cwd, {
      stopReason: "error",
      errorMessage: "offline provider failed",
      textChunks: [],
    });
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(collect(runtime, request())).rejects.toThrow("offline provider failed");

    await writeLocalPiScenario(cwd, {
      fabricComplete: {
        id: "helper-1",
        name: "reviewer",
        task: "Review the patch",
        status: "completed",
        text: "No findings",
      },
      textChunks: ["done"],
    });
    const events = await collect(
      runtime,
      request({ runId: "fabric-complete", sourceMessageId: "fabric-complete" }),
    );
    expect(events).toContainEqual({
      type: "subagent",
      agentId: "helper-1",
      name: "reviewer",
      task: "Review the patch",
      status: "completed",
      result: "No findings",
    });
    expect(events.filter((event) => event.type === "subagent")).toHaveLength(1);
  });

  it("persists rejected queue delivery for one replay and does not replay accepted delivery", async () => {
    await writeLocalPiScenario(cwd, { rejectPrompt: true });
    let saved: unknown;
    let delivered = false;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const boundary: NonNullable<AgentRunRequest["runtimeBoundary"]> = async (
      boundaryName,
      control,
    ) => {
      if (boundaryName !== "idle" || delivered) return;
      delivered = true;
      await control.deliver({ id: "durable-row", messageId: "durable-message", text: "Do once" });
    };
    await expect(
      collect(
        runtime,
        request({
          queueOnly: true,
          runtimeBoundary: boundary,
          session: {
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ),
    ).rejects.toThrow(/rejected/i);
    expect((saved as { outbox?: unknown[] }).outbox).toHaveLength(1);

    await writeLocalPiScenario(cwd, { textChunks: ["applied"] });
    const replayed = await collect(
      runtime,
      request({
        runId: "replay",
        queueOnly: true,
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    expect(replayed).toContainEqual({ type: "done", text: "applied" });
    expect((saved as { outbox?: unknown[] }).outbox).toHaveLength(0);
    const promptCount = commands(await readLocalPiEmulatorLog(cwd), "prompt").length;

    await collect(
      runtime,
      request({
        runId: "no-replay",
        sourceMessageId: "no-replay",
        queueOnly: true,
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    expect(commands(await readLocalPiEmulatorLog(cwd), "prompt")).toHaveLength(promptCount);
  });

  it("does not replay a queue intent accepted before a CLI crash", async () => {
    await writeLocalPiScenario(cwd, { exitOnPrompt: true });
    let saved: unknown;
    let delivered = false;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(
        runtime,
        request({
          queueOnly: true,
          runtimeBoundary: async (boundary, control) => {
            if (boundary !== "idle" || delivered) return;
            delivered = true;
            await control.deliver({
              id: "accepted-row",
              messageId: "accepted-message",
              text: "Already accepted",
            });
          },
          session: {
            save: async (value) => {
              saved = value;
            },
          },
        }),
      ),
    ).rejects.toThrow(/exited|disconnected/);
    expect((saved as { outbox?: unknown[] }).outbox).toHaveLength(0);
    const promptCount = commands(await readLocalPiEmulatorLog(cwd), "prompt").length;

    await writeLocalPiScenario(cwd, { textChunks: ["must not run"] });
    await collect(
      runtime,
      request({
        runId: "accepted-retry",
        sourceMessageId: "accepted-retry",
        queueOnly: true,
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      }),
    );
    expect(commands(await readLocalPiEmulatorLog(cwd), "prompt")).toHaveLength(promptCount);
  });

  it("does not start Pi when the initial lease is already paused", async () => {
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const events = await collect(runtime, request({ assertActive: async () => "pause" }));
    expect(events).toEqual([
      { type: "runtime_activity", activity: "queue", status: "paused" },
      { type: "done" },
    ]);
    expect(
      (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start"),
    ).toHaveLength(0);
  });

  it("reports failed compaction instead of completed", async () => {
    await writeLocalPiScenario(cwd, { compactionError: "summary failed" });
    let result: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const events = await collect(
      runtime,
      request({
        runtimeBoundary: async (boundary, control) => {
          if (boundary !== "idle" || result) return;
          result = await control.command(
            { kind: "compact" },
            { id: "compact", signal: AbortSignal.timeout(2_000) },
          );
        },
      }),
    );
    expect(result).toEqual({ outcome: "rejected", error: "Pi compaction failed or was aborted" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime_activity",
        activity: "compaction",
        status: "failed",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "runtime_activity",
        activity: "compaction",
        status: "completed",
      }),
    );
  });

  it("cancels the owned Pi process group when a lease check fails", async () => {
    await writeLocalPiScenario(cwd, { waitForAbort: true, spawnChild: true });
    let checks = 0;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const running = collect(
      runtime,
      request({
        assertActive: async () => {
          checks++;
          if (checks >= 3) throw new Error("lease was lost");
        },
      }),
      AbortSignal.timeout(20_000),
    );
    await expect(running).rejects.toThrow(/lease was lost|disconnected/);
    const descendant = (await readLocalPiEmulatorLog(cwd)).find(
      (entry) => entry.type === "descendant",
    );
    const pid = descendant?.pid as number;
    expect(pid).toBeTypeOf("number");
    await waitFor(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
  });

  it("authorizes a nested workspace, rebinds product tools and resumes its canonical session", async () => {
    const selected = join(cwd, "projects", "selected");
    await mkdir(selected, { recursive: true });
    await writeLocalPiScenario(selected, {
      tool: { name: "attach_file", args: { path: "proof.txt" } },
    });
    const original = vi.fn(async () => {
      throw new Error("Unbound callback used");
    });
    const rebound = vi.fn(async (_name, args) => {
      await writeFile(join(selected, args.path), "selected-workspace");
      return "attached";
    });
    const authorize = vi.fn(async (placement) => ({ placement, executeTool: rebound }));
    let saved: unknown;
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    const run = () =>
      request({
        placement: { cwd: "projects/selected", worktreeId: "selected" },
        authorizeSubagentPlacement: authorize,
        executeTool: original,
        tools: [
          {
            name: "attach_file",
            description: "Attach file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        session: {
          restore: saved,
          save: async (value) => {
            saved = value;
          },
        },
      });
    await collect(runtime, run());
    expect(authorize).toHaveBeenCalledWith(
      { cwd: "projects/selected", worktreeId: "selected" },
      "run",
    );
    expect(original).not.toHaveBeenCalled();
    expect(await readFile(join(selected, "proof.txt"), "utf8")).toBe("selected-workspace");
    await expect(readFile(join(cwd, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const first = (await readLocalPiEmulatorLog(selected)).find((entry) => entry.type === "start")!;
    const file = (first.args as string[])[3]!;
    expect(JSON.parse((await readFile(file, "utf8")).split("\n")[0]!).cwd).toBe(
      await realpath(selected),
    );
    await collect(runtime, { ...run(), runId: "resume-nested", sourceMessageId: "resume-nested" });
    const starts = (await readLocalPiEmulatorLog(selected)).filter(
      (entry) => entry.type === "start",
    );
    expect((starts[1]!.args as string[])[3]).toBe(file);
  });

  it("rejects unauthorized descendants, symlink escapes and authorization retargeting before RPC", async () => {
    const selected = join(cwd, "selected");
    const other = join(cwd, "other");
    const outside = join(root, "outside");
    await Promise.all([mkdir(selected), mkdir(other), mkdir(outside)]);
    await symlink(outside, join(cwd, "escape"));
    const authorize = vi.fn(async (placement) => ({
      placement,
      executeTool: async () => "unused",
    }));
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(collect(runtime, request({ placement: { cwd: "selected" } }))).rejects.toThrow(
      "authorization is required",
    );
    await expect(
      collect(
        runtime,
        request({ placement: { cwd: "escape" }, authorizeSubagentPlacement: authorize }),
      ),
    ).rejects.toThrow("authoritative constructor cwd");
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      collect(
        runtime,
        request({
          placement: { cwd: "selected" },
          authorizeSubagentPlacement: async () => ({
            placement: { cwd: "other" },
            executeTool: async () => "unused",
          }),
        }),
      ),
    ).rejects.toThrow("changed the requested cwd");
    expect(
      (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start"),
    ).toHaveLength(0);
  });

  it("rejects a queued cwd change before rebinding callbacks or accepting intent", async () => {
    await mkdir(join(cwd, "other"));
    const authorize = vi.fn(async (placement) => ({
      placement,
      executeTool: async () => "unused",
    }));
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(
        runtime,
        request({
          queueOnly: true,
          session: { save: async () => undefined },
          authorizeSubagentPlacement: authorize,
          runtimeBoundary: async (boundary, control) => {
            if (boundary === "idle")
              await control.deliver({
                id: "move",
                messageId: "move",
                text: "Move workspace",
                placement: { cwd: "other" },
              });
          },
        }),
      ),
    ).rejects.toThrow("requires a new run");
    expect(authorize).not.toHaveBeenCalled();
    expect(commands(await readLocalPiEmulatorLog(cwd), "prompt")).toHaveLength(0);
  });

  it("rejects placement drift and incompatible Pi versions before starting RPC", async () => {
    const runtime = new LocalPiRuntime({ command, cwd, sessionDir });
    await expect(
      collect(runtime, request({ placement: { cwd: join(root, "other-workspace") } })),
    ).rejects.toThrow("authoritative constructor cwd");
    await expect(
      collect(
        runtime,
        request({
          runId: "queued-placement",
          queueOnly: true,
          runtimeBoundary: async (boundary, control) => {
            if (boundary === "idle")
              await control.deliver({
                id: "placed",
                messageId: "placed-message",
                text: "Move",
                placement: { cwd: join(root, "other-workspace") },
              });
          },
        }),
      ),
    ).rejects.toThrow("authoritative constructor cwd");

    const startsBeforeVersionCheck = (await readLocalPiEmulatorLog(cwd)).filter(
      (entry) => entry.type === "start",
    ).length;
    await writeLocalPiScenario(cwd, { version: "0.84.9" });
    await expect(collect(runtime, request({ runId: "old-version" }))).rejects.toThrow(
      "0.85.1 or newer",
    );
    expect(
      (await readLocalPiEmulatorLog(cwd)).filter((entry) => entry.type === "start"),
    ).toHaveLength(startsBeforeVersionCheck);
  });
});
