import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBrokerCall,
  type ManagedResult,
  managedCoreTools,
} from "../../adapters/src/pi-managed-tools.js";
import { RunAuthority, ToolBridge } from "../../adapters/src/pi-rpc-tool-bridge.js";

const integration =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
integration("atomic edit actual executor effect boundary", () => {
  let app: Awaited<ReturnType<typeof import("../../../apps/api/src/app.js")["createApp"]>>;
  let root: string;
  let sourcePath: string;
  let owner: { userId: string; spaceId: string };
  let botId: string;
  let threadId: string;
  let approving = false;
  let commands = 0;
  let reads = 0;
  const results: unknown[] = [];
  const secret = "fake-only-atomic-editor-credential";
  const original = `\ufeffkey=${secret}\r\na=old\r\nb=old\r\n`;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "atomic-edit-db-"));
    const { createApp } = await import("../../../apps/api/src/app.js");
    app = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: join(root, "data"),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      deploymentModelKey: secret,
    });
    const signup = await app.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `atomic-${randomUUID()}@rakazo.test`,
        name: "Atomic fixture",
        password: "password12",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = `better-auth.session_token=${signup.headers.get("set-cookie")!.match(/better-auth\.session_token=([^;]+)/)![1]}`;
    const rpc = async (name: string, json: unknown = {}) => {
      const response = await app.app.request(`/rpc/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173", cookie },
        body: JSON.stringify({ json }),
      });
      expect(response.status).toBeLessThan(400);
      return ((await response.json()) as { json: any }).json;
    };
    const me = await rpc("me");
    owner = { userId: me.userId, spaceId: me.spaceId };
    botId = (
      await rpc("bots/create", {
        name: "Atomic fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      })
    ).id;
    threadId = (await app.prisma.thread.findUniqueOrThrow({ where: { botId } })).id;
    const workspace = join(root, "computer");
    await mkdir(workspace);
    const read = app.sandbox.readFile.bind(app.sandbox);
    vi.spyOn(app.sandbox, "readFile").mockImplementation(
      async (computer, path, context, options) => {
        if (!path.endsWith("source.txt")) return read(computer, path, context, options);
        reads++;
        sourcePath = join(workspace, path);
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, original);
        return Buffer.from(original);
      },
    );
    const execute = app.sandbox.execute.bind(app.sandbox);
    vi.spyOn(app.sandbox, "execute").mockImplementation(
      async function* (computer, request, context) {
        if (request.argv[0] !== "python3") {
          yield* execute(computer, request, context);
          return;
        }
        commands++;
        // Fake transport only. The executor supplies the unchanged production program and path.
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
          (resolve) => {
            execFile(
              request.argv[0]!,
              request.argv.slice(1),
              { cwd: workspace, timeout: 10000 },
              (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }),
            );
          },
        );
        yield { type: "stdout", data: result.stdout };
        yield { type: "stderr", data: result.stderr };
        yield { type: "exit", code: result.code };
      },
    );
    const descriptor = app.runtime.describe();
    vi.spyOn(app.runtime, "describe").mockReturnValue({
      ...descriptor,
      id: "pi",
      capabilities: { ...descriptor.capabilities, scripted: false },
    });
    vi.spyOn(app.runtime, "run").mockImplementation(async function* (request) {
      expect(request.tools.some((tool) => tool.name === "edit_file")).toBe(true);
      if (!approving) {
        const redacted = await request.executeTool!(
          "read_file",
          { path: "source.txt" },
          randomUUID(),
        );
        expect(JSON.stringify(redacted)).toContain("[redacted]");
        expect(JSON.stringify(redacted)).not.toContain(secret);
      }
      const authority = new RunAuthority(request, new AbortController().signal);
      const pending: AgentRuntimeEvent[] = [];
      const makeEdit = (run: AgentRunRequest) => {
        const bridge = new ToolBridge(
          run,
          authority,
          (event) => pending.push(event),
          async () => undefined,
        );
        const entry = bridge.catalog.find((tool) => tool.name === "edit_file")!;
        const proxy: ToolDefinition = {
          name: "edit_file",
          label: "edit",
          description: entry.description,
          parameters: entry.parameters as ToolDefinition["parameters"],
          execute: async (id, args) =>
            (
              (await bridge.invoke({ handle: entry.handle, callId: id, args })) as {
                result: ManagedResult;
              }
            ).result,
        };
        const edit = managedCoreTools(createBrokerCall([proxy], () => authority.paused)).find(
          (tool) => tool.name === "edit",
        )!;
        return async (oldText: string, newText: string) => {
          try {
            return await edit.execute(
              randomUUID(),
              { path: "source.txt", edits: [{ oldText, newText }] },
              undefined,
              undefined,
              {} as ExtensionContext,
            );
          } finally {
            bridge.publishPause();
          }
        };
      };
      const outcomes = await Promise.allSettled([
        makeEdit(request)("a=old", "a=new"),
        makeEdit({ ...request, runId: "child" })("b=old", "b=new"),
      ]);
      if (approving) expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
      else expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      results.push(outcomes);
      await request.session?.save({ version: 1, marker: "atomic-test-checkpoint" });
      for (const event of pending) yield event;
      if (!authority.paused) yield { type: "done", text: "Complete" };
    });
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const run = async () => {
    const task = await app.prisma.task.create({
      data: { ...owner, botId, threadId, prompt: "Edit source", status: "queued" },
    });
    const row = await app.prisma.run.create({
      data: { ...owner, botId, threadId, taskId: task.id, trigger: "user", status: "queued" },
    });
    await app.executor.continueRun(row.id, "atomic-test-worker");
    return app.prisma.run.findUniqueOrThrow({ where: { id: row.id } });
  };
  it("preserves known redacted credentials and concurrent edits through persisted executor effects", async () => {
    const row = await run();
    expect(row.status, row.error ?? "executor status").toBe("completed");
    expect(reads).toBe(1);
    expect(commands).toBe(2);
    expect(await readFile(sourcePath)).toEqual(
      Buffer.from(original.replace("a=old", "a=new").replace("b=old", "b=new")),
    );
    const effects = await app.prisma.externalEffect.findMany({
      where: { runId: row.id, kind: "edit_file" },
    });
    expect(effects).toHaveLength(2);
    expect(effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(JSON.stringify({ effects, results })).not.toContain(secret);
  });
  it("pauses at the real approval boundary without executing or partially writing", async () => {
    approving = true;
    const before = await readFile(sourcePath);
    await app.prisma.actionApprovalRule.create({
      data: {
        spaceId: owner.spaceId,
        createdByUserId: owner.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "edit_file",
      },
    });
    const row = await run();
    expect(row.status).toBe("waiting_input");
    expect(commands).toBe(2);
    expect(await readFile(sourcePath)).toEqual(before);
    const effects = await app.prisma.externalEffect.findMany({
      where: { runId: row.id, kind: "edit_file" },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.status).toBe("intended");
    expect(JSON.stringify({ effects, results })).not.toContain(secret);
  });
});
