import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const integration =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
integration("executor durable runtime boundary", () => {
  let app: Awaited<ReturnType<typeof import("../../../apps/api/src/app.js")["createApp"]>>;
  const dir = mkdtempSync(join(tmpdir(), "rakazo-runtime-db-"));
  let owner: { userId: string; spaceId: string };
  let botId: string;
  let threadId: string;
  const requests: AgentRunRequest[] = [];
  let inspectRequest: ((request: AgentRunRequest) => Promise<void>) | undefined;
  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.js");
    app = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: dir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
    const signup = await app.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `runtime-${Date.now()}@rakazo.test`,
        name: "Runtime test",
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
        name: "Runtime fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      })
    ).id;
    threadId = (await app.prisma.thread.findUniqueOrThrow({ where: { botId } })).id;
    const descriptor = app.runtime.describe();
    vi.spyOn(app.runtime, "describe").mockReturnValue({ ...descriptor, id: "pi" });
    vi.spyOn(app.runtime, "run").mockImplementation(async function* (request) {
      requests.push(request);
      await inspectRequest?.(request);
      await request.session?.save({
        version: 1,
        marker: "private transcript",
        participants: { child: { marker: "durable child" } },
      });
      yield {
        type: "execution",
        executionId: "fixture",
        participantId: request.runId,
        status: "completed",
        name: "fabric_exec",
        code: "return 1;",
        output: [{ type: "text", text: "real retained evidence" }],
      };
      yield { type: "done", text: "Complete" };
    });
  }, 30000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async (trigger = "user", destination = threadId, prompt = "Continue") => {
    const task = await app.prisma.task.create({
      data: { ...owner, botId, threadId: destination, prompt, status: "queued" },
    });
    const row = await app.prisma.run.create({
      data: { ...owner, botId, threadId: destination, taskId: task.id, trigger, status: "queued" },
    });
    await app.executor.continueRun(row.id, "runtime-test-worker");
    expect((await app.prisma.run.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "completed",
    );
    return row;
  };
  it("persists root and child checkpoints, restores the next run, and retains known worktree placement", async () => {
    await run();
    const computer = await app.prisma.computer.findFirstOrThrow({
      where: { bots: { some: { id: botId } } },
    });
    await app.prisma.runtimePlacement.create({
      data: {
        spaceId: owner.spaceId,
        threadId,
        botId,
        computerId: computer.id,
        homeKey: computer.homeKey,
        projectPath: "projects/repo",
        worktreePath: "worktrees/feature",
      },
    });
    await run();
    expect(requests.at(-1)?.session?.restore).toMatchObject({
      marker: "private transcript",
      participants: { child: { marker: "durable child" } },
    });
    expect(requests.at(-1)?.placement).toEqual({
      cwd: "worktrees/feature",
      worktreeId: "worktrees/feature",
    });
    const stored = await app.prisma.runtimeSession.findFirstOrThrow({ where: { threadId } });
    expect(stored.revision).toBe(2);
  });
  it("recalls retained DM work in fresh and restored group turns without remember", async () => {
    await app.prisma.message.create({
      data: {
        threadId,
        botId,
        seq: 9000,
        role: "assistant",
        blocks: [{ kind: "text", text: "The deployment uses the cobalt queue." }],
      },
    });
    const group = await app.prisma.chatGroup.create({
      data: {
        ...owner,
        name: "Memory group",
        members: { create: { botId } },
        thread: { create: owner },
      },
      include: { thread: true },
    });
    let turn = 0;
    inspectRequest = async (request) => {
      expect(request.memory).toBeTypeOf("function");
      expect(
        request.history.some(
          (item) => item.id === `memory:${request.runId}` && item.content.includes("cobalt"),
        ),
      ).toBe(true);
      if (turn++) expect(request.session?.restore).toMatchObject({ marker: "private transcript" });
      const signal = new AbortController().signal;
      const page = (await request.memory!({
        action: "recall",
        args: { query: "cobalt" },
        signal,
      })) as any;
      expect(page.error).toBeUndefined();
      const pointer = page.hits.find((hit: any) => hit.follow.ref === "memory.expand").follow;
      const expanded = await request.memory!({ action: "expand", args: pointer.args, signal });
      expect(JSON.stringify(expanded)).toContain("cobalt queue");
      if (turn === 2) {
        await app.prisma.message.deleteMany({ where: { threadId, seq: 9000 } });
        const cleared = (await request.memory!({
          action: "expand",
          args: pointer.args,
          signal,
        })) as any;
        expect(cleared.error).toBeDefined();
        expect(JSON.stringify(cleared)).not.toContain("cobalt queue");
      }
    };
    try {
      await run("user", group.thread!.id, "Which cobalt deployment queue did we choose?");
      await run("user", group.thread!.id, "Recall the cobalt deployment queue.");
    } finally {
      inspectRequest = undefined;
    }
  });
  it.each(["messaging", "bot_message", "webhook"])(
    "never restores or dispatches private state in %s",
    async (trigger) => {
      await run(trigger);
      const request = requests.at(-1)!;
      expect(request.session).toBeUndefined();
      expect(request.runtimeBoundary).toBeUndefined();
      expect(request.tools.map((tool) => tool.name)).not.toContain("manage_queue");
      expect(JSON.stringify(request.history)).not.toContain("private transcript");
      expect(
        (await app.prisma.runtimeSession.findFirstOrThrow({ where: { threadId } })).revision,
      ).toBe(2);
    },
  );
});
