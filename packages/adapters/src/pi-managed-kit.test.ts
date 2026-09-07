import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, Type } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { safeSnapshotPath } from "./pi-managed-fovea.js";
import { createManagedKit, type ManagedKit } from "./pi-managed-kit.js";
import { createBrokerCall, managedCoreTools, textResult } from "./pi-managed-tools.js";

// A coding harness may itself be a scoped Fabric child. Do not inherit its tool restrictions
// or mesh routing into the independent offline worker fixture.
beforeAll(() => {
  for (const name of Object.keys(process.env))
    if (/^(PI_|FABRIC_)/.test(name)) vi.stubEnv(name, undefined);
});
afterAll(() => vi.unstubAllEnvs());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
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
const proxy = (
  name: string,
  execute: ToolDefinition["execute"],
  properties: Record<string, ToolDefinition["parameters"]> = { path: Type.String() },
): ToolDefinition => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object(properties),
  execute,
});
async function harness(
  proxies: ToolDefinition[],
  extra: {
    restore?: unknown;
    manager?: SessionManager;
    now?: () => number;
    getPlacement?: () => { cwd: string; worktreeId?: string };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "managed-kit-test-"));
  let runtime: AgentSessionRuntime | undefined;
  let kit: ManagedKit | undefined;
  cleanups.push(async () => {
    await kit?.dispose();
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const activity = vi.fn(async (..._args: unknown[]) => undefined);
  const checkpoint = vi.fn(async (): Promise<void> => undefined);
  kit = await createManagedKit({
    instructions: "Use Fabric through authorized tools only.",
    proxyTools: proxies,
    scratchRoot: root,
    activity,
    checkpoint,
    restore: extra.restore,
    now: extra.now,
    getPlacement: extra.getPlacement,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const paid = vi.fn(() => {
    throw new Error("Paid model must not run in offline compaction probe");
  });
  modelRuntime.completeSimple = paid;
  modelRuntime.complete = paid;
  modelRuntime.streamSimple = paid;
  modelRuntime.stream = paid;
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
    { cwd: root, agentDir: root, sessionManager: extra.manager ?? SessionManager.inMemory(root) },
  );
  await runtime.session.bindExtensions({});
  await kit.initialize(runtime);
  const exec = async (code: string) => {
    const tool = runtime!.session.agent.state.tools.find((tool) => tool.name === "fabric_exec");
    if (!tool) throw new Error("Fabric not active");
    return tool.execute("fabric-probe", { code }, new AbortController().signal);
  };
  return { kit, runtime, exec, paid, activity, checkpoint };
}

describe("managed Pi kit", () => {
  it("loads the sixth visibility extension without exposing worker-local preference writes", async () => {
    const { kit, runtime, paid } = await harness([]);
    const extension = kit.resourceLoader
      .getExtensions()
      .extensions.find((entry) => entry.commands.has("hide-models"));
    expect(extension?.path).toMatch(/hide-providers\.ts$/);
    expect(extension?.handlers.has("session_start")).toBe(true);
    const requested = runtime.session.model;
    await runtime.session.prompt("/hide-models add test");
    expect(runtime.session.model).toEqual(requested);
    expect(paid).not.toHaveBeenCalled();
    await expect(
      extension!.commands
        .get("hide-models")!
        .handler("reset", runtime.session.extensionRunner.createContext() as never),
    ).rejects.toThrow("Rakazo model settings");
  }, 60000);
  it("captures all core operations in real Fabric and delegates only through authorized proxies", async () => {
    const read = vi.fn(async () => textResult(JSON.stringify({ content: "authorized source" })));
    const write = vi.fn(async () => textResult(JSON.stringify({ ok: true })));
    const delegate = vi.fn(async () => textResult("scoped child complete"));
    const { exec, runtime, activity } = await harness([
      proxy("read_file", read),
      proxy("write_file", write, { path: Type.String(), content: Type.String() }),
      proxy("run_subagent", delegate, { name: Type.String(), task: Type.String() }),
    ]);
    expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual(["fabric_exec"]);
    const result = await exec(
      'const read = await pi.read("notes.txt"); await pi.write("out.txt", read); const child = await agents.run({task:"review"}); return {read, child};',
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("authorized source"),
        }),
      ]),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(delegate).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalled();
    const denied = await exec('return await tools.call({ref:"schema.commit", args:{}});');
    expect(JSON.stringify(denied)).toMatch(/unknown|not found|unavailable/i);
  }, 60000);

  it("acknowledges manual compaction only after durable intent and actual deterministic completion", async () => {
    const manager = SessionManager.inMemory("/work");
    const original = manager.appendMessage({
      role: "user",
      content: "Retain this goal " + "old detail ".repeat(10000),
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: "Recent task " + "recent ".repeat(1000),
      timestamp: 2,
    });
    const { kit, runtime, paid, checkpoint } = await harness([], { manager });
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    checkpoint.mockImplementationOnce(() => persisted);
    const work = kit.compact("Retain the goal");
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalled());
    expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    release();
    await work;
    expect(manager.getEntry(original)).toBeDefined();
    expect(
      runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(paid).not.toHaveBeenCalled();
  }, 60000);

  it.each([false, true])(
    "keeps real SDK cancellation visible and retryable (handoff: %s)",
    async (requireSuccess) => {
      const manager = SessionManager.inMemory("/work");
      manager.appendMessage({
        role: "user",
        content: "Original goal " + "detail ".repeat(16000),
        timestamp: 1,
      });
      manager.appendMessage({
        role: "user",
        content: "Recent task " + "recent ".repeat(1000),
        timestamp: 2,
      });
      const { kit, runtime, paid } = await harness([], { manager });
      const before = manager.getEntries();
      const hooks = kit.resourceLoader
        .getExtensions()
        .extensions.find((extension) => extension.path.includes("rakazo-managed"))!
        .handlers.get("session_before_compact")!;
      const abort = async () => {
        runtime.session.abortCompaction();
      };
      hooks.push(abort);
      await expect(kit.compact(undefined, { requireSuccess })).rejects.toThrow(
        "Compaction cancelled",
      );
      expect(kit.snapshot()).toMatchObject({ pendingCompact: { requireSuccess } });
      expect(kit.snapshot()).not.toHaveProperty("compactedSource");
      expect(manager.getEntries()).toEqual(before);
      hooks.splice(hooks.indexOf(abort), 1);
      await kit.compact(undefined, { requireSuccess });
      expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(kit.snapshot()).not.toHaveProperty("pendingCompact");
      expect(paid).not.toHaveBeenCalled();
    },
    60000,
  );

  it("performs TTL cold-return compaction with actual Fabric and preserves exact source", async () => {
    const manager = SessionManager.inMemory("/work");
    const first = manager.appendMessage({
      role: "user",
      content: "Original goal: preserve exact source " + "old detail ".repeat(10000),
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: "Recent task " + "recent ".repeat(1000),
      timestamp: 2,
    });
    const { runtime, kit, paid, checkpoint, exec } = await harness([], {
      manager,
      restore: { version: 1, idleAt: 1 },
      now: () => 600001,
    });
    expect(paid).not.toHaveBeenCalled();
    const marker = runtime.session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "compaction");
    expect(marker).toMatchObject({ details: { compactor: "fabric", version: 2 } });
    expect(runtime.session.sessionManager.getEntry(first)).toBeDefined();
    expect(checkpoint).toHaveBeenCalled();
    await kit.settle();
    await kit.settle();
    expect(
      runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    const recalled = await exec(
      `return await memory.expand({session:"current",entryIds:[${JSON.stringify(first)}],maxChars:512});`,
    );
    expect(JSON.stringify(recalled)).toContain("Original goal");
  }, 60000);

  it("routes all eight Pi overrides through captured authorized tools", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const tool = (
      name: string,
      value: unknown,
      properties: Record<string, ToolDefinition["parameters"]>,
    ) =>
      proxy(
        name,
        async (_id, args) => {
          calls.push({ name, args });
          return textResult(JSON.stringify(value));
        },
        properties,
      );
    const { exec } = await harness([
      tool("read_file", { content: "first\nsecond\nthird" }, { path: Type.String() }),
      tool("write_file", { ok: true }, { path: Type.String(), content: Type.String() }),
      tool(
        "edit_file",
        { ok: true },
        {
          path: Type.String(),
          edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
        },
      ),
      tool("list_files", { entries: [{ path: "src", kind: "dir" }] }, { path: Type.String() }),
      tool(
        "shell",
        { stdout: "src/index.ts:1:export function greeting() {}", exitCode: 0 },
        { command: Type.String(), cwd: Type.Optional(Type.String()) },
      ),
    ]);
    const result = await exec(
      'const read = await pi.read({path:"a.txt",offset:2,limit:1}); await pi.edit({path:"a.txt",edits:[{oldText:"second",newText:"changed"}]}); await pi.write("b.txt","text"); const ls = await pi.ls("."); await pi.bash("git worktree add /not-on-worker"); await pi.powershell("Write-Output ok"); await pi.grep({pattern:"greeting",path:"src",literal:true}); await pi.find({pattern:"*.ts",path:"src"}); return {read,ls};',
    );
    expect(result.details, JSON.stringify(result)).toMatchObject({ success: true });
    expect(JSON.stringify(result)).toContain("second");
    expect(JSON.stringify(result)).toContain("src/");
    expect(calls.filter((call) => call.name === "shell")).toHaveLength(4);
    expect(calls.find((call) => call.name === "edit_file")?.args).toEqual({
      path: "a.txt",
      edits: [{ oldText: "second", newText: "changed" }],
    });
    expect(calls.filter((call) => call.name === "read_file")).toHaveLength(1);
    expect(calls.find((call) => call.name === "write_file")?.args).toEqual({
      path: "b.txt",
      content: "text",
    });
    expect(
      calls.some(
        (call) =>
          call.name === "shell" &&
          JSON.stringify(call.args).includes("git worktree add /not-on-worker"),
      ),
    ).toBe(true);
    for (const ref of ["schema.commit", "mcp.$register", "mesh.publish", "components.reload"]) {
      const denied = await exec(`return await tools.call({ref:${JSON.stringify(ref)},args:{}});`);
      expect(JSON.stringify(denied)).toMatch(/unknown|not found|unavailable/i);
    }
    const native = await exec("return process.env;");
    expect(JSON.stringify(native)).toMatch(/Cannot find name|not defined/);
    const again = await exec('return await pi.bash("echo still-brokered");');
    expect(JSON.stringify(again)).toContain("greeting");
  }, 60000);

  it("builds real Fovea graphs for bound computer roots without reading config or secrets", async () => {
    const reads: string[] = [];
    const listing = proxy("list_files", async (_id, args) => {
      const root = (args as { path: string }).path;
      return textResult(
        JSON.stringify({
          entries: [
            { path: `${root}/index.ts`, kind: "file", size: 100 },
            { path: `${root}/.env`, kind: "file", size: 20 },
            { path: `${root}/.pi`, kind: "dir" },
            { path: `${root}/credentials.ts`, kind: "file", size: 20 },
            { path: "../outside.ts", kind: "file", size: 10 },
          ],
        }),
      );
    });
    const read = proxy("read_file", async (_id, args) => {
      const path = (args as { path: string }).path;
      reads.push(path);
      return textResult(
        JSON.stringify({
          content: `export function ${path.startsWith("project-a") ? "greeting" : "farewell"}() { return "ok"; }`,
        }),
      );
    });
    const { exec } = await harness([listing, read]);
    const catalog = await exec('return await tools.list({provider:"extensions"});');
    expect(JSON.stringify(catalog)).toContain("fovea_focus");
    const a = await exec(
      'return await extensions.fovea_focus({root:"project-a",query:"greeting"});',
    );
    expect(JSON.stringify(a)).toContain('"available":true');
    const b = await exec(
      'return await extensions.fovea_focus({root:"project-b",query:"farewell"});',
    );
    expect(JSON.stringify(b)).toContain("project-b");
    const dwell = await exec("return await extensions.fovea_dwell({});");
    expect(JSON.stringify(dwell)).toContain("project-b");
    expect(reads).toEqual(["project-a/index.ts", "project-b/index.ts", "project-b/index.ts"]);
  }, 60000);

  it("invalidates authorized graph bindings when queue delivery changes placement", async () => {
    let cwd = "project-a";
    const listing = vi.fn(async () =>
      textResult(JSON.stringify({ entries: [{ path: `${cwd}/index.ts`, kind: "file" }] })),
    );
    const read = vi.fn(async () =>
      textResult(
        JSON.stringify({
          content: `export function ${cwd === "project-a" ? "alpha" : "beta"}() { return 1; }`,
        }),
      ),
    );
    const { exec, kit } = await harness([proxy("list_files", listing), proxy("read_file", read)], {
      getPlacement: () => ({ cwd }),
    });
    expect(
      JSON.stringify(await exec('return await extensions.fovea_focus({query:"alpha", root:"."});')),
    ).toContain("alpha");
    await kit.setPlacement({ cwd: ".worktrees/review", worktreeId: "review" });
    cwd = ".worktrees/review";
    const next = await exec('return await extensions.fovea_focus({query:"beta"});');
    expect(next).not.toMatchObject({ isError: true });
    expect(JSON.stringify(next)).toContain("beta");
    expect(JSON.stringify(kit.snapshot())).not.toContain("project-a");
    expect(read.mock.calls.length).toBe(2);
  }, 30000);

  it("waits for real retry lifecycle and cancels its idle backoff on authority pause", async () => {
    const { runtime, kit, paid, activity } = await harness([]);
    const failed = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage: "Connection reset",
      timestamp: 1,
    };
    runtime.session.sessionManager.appendMessage(failed);
    runtime.session.agent.state.messages = [failed];
    await runtime.session.extensionRunner.emit({ type: "agent_end", messages: [failed] });
    await vi.waitFor(() =>
      expect(activity.mock.calls.some((call) => call[0] === "retry" && call[1] === "started")).toBe(
        true,
      ),
    );
    let settled = false;
    const pending = kit.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await kit.pause();
    await pending;
    expect(kit.snapshot()).toMatchObject({ retry: { status: "cancelled" } });
    expect(paid).not.toHaveBeenCalled();
    await expect(kit.beforeModel()).rejects.toThrow(/paused/);
  }, 60000);

  it("excludes secret/config/traversal paths from snapshots", () => {
    for (const path of [
      ".env",
      ".pi/extensions/evil.ts",
      "credentials.ts",
      "../outside.ts",
      "/outside.ts",
      "src/../../outside.ts",
      "src/private.key",
      "src\\evil.ts",
    ])
      expect(safeSnapshotPath(path)).toBe(false);
    expect(safeSnapshotPath("shared/project/src/index.ts")).toBe(true);
  });

  it("has no native fallback and latches before sibling writes", async () => {
    let paused = false;
    const read = proxy("read_file", async () => {
      paused = true;
      return { ...textResult("approval"), terminate: true };
    });
    const write = vi.fn(async () => textResult("wrong"));
    const call = createBrokerCall([read, proxy("write_file", write)], () => paused);
    const tools = managedCoreTools(call);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "powershell",
      "read",
      "write",
    ]);
    await expect(call("read_file", { path: "a" })).rejects.toThrow(/paused/);
    await expect(call("write_file", { path: "b", content: "bad" })).rejects.toThrow(/paused/);
    expect(write).not.toHaveBeenCalled();
    await expect(
      createBrokerCall([], () => false)("read_file", { path: "/etc/passwd" }),
    ).rejects.toThrow(/unavailable/);
  });
});
