import { describe, expect, it, vi } from "vitest";
import { cleanupActors, type EvalActor, type EvalApp, runTrial } from "./runner.js";

const actors: EvalActor[] = [
  {
    botId: "root-bot",
    cookie: "root-session",
    userId: "eval-user",
    spaceId: "eval-space",
  },
];

function fixture(options: { failDisable?: boolean; failStop?: boolean } = {}) {
  const bots = [
    { id: "root-bot", userId: "eval-user", spaceId: "eval-space" },
    { id: "child-bot", userId: "eval-user", spaceId: "eval-space" },
  ];
  const runs = [
    { id: "root-run", botId: "root-bot", status: "running" },
    { id: "child-run", botId: "child-bot", status: "running" },
  ];
  const order: string[] = [];
  let lateChildCreated = false;
  let releaseQuietAbort!: () => void;
  const quietAbort = new Promise<void>((resolve) => {
    releaseQuietAbort = resolve;
  });
  const updateMany = vi.fn(async () => {
    order.push("disable");
    if (options.failDisable) throw new Error("database unavailable");
    return { count: 1 };
  });
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { json: { botId: string } };
    order.push(`stop:${body.json.botId}`);
    for (const run of runs) if (run.botId === body.json.botId) run.status = "cancelled";
    return Response.json({ json: { ok: true } }, { status: options.failStop ? 500 : 200 });
  });
  const cancel = vi.fn(async (key: string) => {
    order.push(`cancel:${key}`);
  });
  const abort = vi.fn(async (runId: string) => {
    order.push(`abort:${runId}`);
    if (runId === "root-run" && !lateChildCreated) {
      lateChildCreated = true;
      bots.push({ id: "late-child-bot", userId: "eval-user", spaceId: "eval-space" });
      runs.push({ id: "late-child-run", botId: "late-child-bot", status: "running" });
    }
    if (runId === "child-run") await quietAbort;
  });
  const findRuns = vi.fn(async (args: { select: { status?: boolean } }) =>
    runs.map((run) => (args.select.status ? { id: run.id, status: run.status } : { id: run.id })),
  );
  const handles = {
    app: { request },
    jobs: { cancel },
    runtime: { abort },
    prisma: {
      bot: { findMany: vi.fn(async () => bots.map((bot) => ({ ...bot }))) },
      run: { findMany: findRuns },
      routine: { updateMany, count: vi.fn(async () => 0) },
    },
  } as unknown as EvalApp;
  return {
    handles,
    order,
    updateMany,
    request,
    cancel,
    abort,
    releaseQuietAbort,
  };
}

describe("eval model fixture setup", () => {
  it.each([false, true])(
    "seeds every actor without retired model RPCs (new workspace: %s)",
    async (newWorkspace) => {
      const scopedActors: Array<{ id: string; userId: string; spaceId: string }> = [];
      const tx = {
        secret: { create: vi.fn(async () => ({})) },
        userModelCredential: {
          create: vi.fn(async () => ({ id: `credential-${scopedActors.length}` })),
        },
        spaceModelPreference: { create: vi.fn(async () => ({})) },
      };
      const update = vi.fn(async () => ({}));
      const request = vi.fn(async (url: string) => {
        if (url === "/api/auth/sign-up/email") {
          const n = scopedActors.length + 1;
          scopedActors.push({ id: `bot-${n}`, userId: `user-${n}`, spaceId: `space-${n}` });
          return Response.json({}, { headers: { "set-cookie": `session=fixture-${n}; Path=/` } });
        }
        const actor = scopedActors.at(-1)!;
        if (url === "/rpc/me")
          return Response.json({ json: { userId: actor.userId, spaceId: actor.spaceId } });
        if (url === "/rpc/bots/create") return Response.json({ json: { id: actor.id } });
        if (url === "/rpc/memory/list") return Response.json({ json: [] });
        if (url === "/rpc/threads/stop") return Response.json({ json: { ok: true } });
        throw new Error(`Unexpected RPC: ${url}`);
      });
      const stop = vi.fn(async () => {});
      const handles = {
        app: { request },
        prisma: {
          $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          bot: {
            findUniqueOrThrow: async () => {
              const { userId, spaceId } = scopedActors.at(-1)!;
              return { userId, spaceId };
            },
            update,
            findMany: async () => scopedActors,
          },
          routine: {
            findMany: async () => [],
            updateMany: async () => ({ count: 0 }),
            count: async () => 0,
          },
          run: { findMany: async () => [] },
          event: { findMany: async () => [] },
          usageRecord: { findMany: async () => [] },
        },
        stop,
      } as unknown as EvalApp;
      const connection = {
        provider: "offline",
        modelId: "fixture-model",
        apiKey: "fake-model-key",
      };
      const grade = vi.fn(() => [{ id: "setup-completed", pass: true }]);
      const result = await runTrial(
        {
          id: "fixture-setup",
          purpose: "Check isolated model fixture setup.",
          connections: [],
          steps: newWorkspace ? [{ newWorkspace: true }] : [],
          grade,
        },
        1,
        { connection, timeoutMs: 5_000, maxToolCalls: 1, createApp: async () => handles },
      );

      expect(result).toMatchObject({ status: "passed", category: null, cleanupFailed: false });
      expect(grade).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(tx.secret.create).toHaveBeenCalledTimes(newWorkspace ? 2 : 1);
      expect(update).toHaveBeenCalledTimes(scopedActors.length);
      for (const [index, actor] of scopedActors.entries()) {
        expect(tx.secret.create).toHaveBeenNthCalledWith(index + 1, {
          data: expect.objectContaining({ userId: actor.userId, spaceId: null, kind: "model" }),
        });
        expect(tx.userModelCredential.create).toHaveBeenNthCalledWith(index + 1, {
          data: expect.objectContaining({ userId: actor.userId, provider: connection.provider }),
        });
        expect(tx.spaceModelPreference.create).toHaveBeenNthCalledWith(index + 1, {
          data: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            credentialId: `credential-${index + 1}`,
            modelId: connection.modelId,
            isDefault: true,
          },
        });
        expect(update).toHaveBeenNthCalledWith(index + 1, {
          where: { id: actor.id },
          data: { modelProvider: connection.provider, modelId: connection.modelId },
        });
      }
      expect(request.mock.calls.flat()).not.toContain("/rpc/models/connect");
      expect(request.mock.calls.flat()).not.toContain("/rpc/bots/update");
    },
  );
});

describe("eval trial isolation", () => {
  it("awaits quiet runtime aborts and catches descendants created during root abort", async () => {
    const f = fixture();
    let settled = false;
    const cleanup = cleanupActors(f.handles, actors).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(f.abort).toHaveBeenCalledWith("child-run"));
    expect(settled).toBe(false);
    f.releaseQuietAbort();
    await cleanup;

    expect(f.request).toHaveBeenCalledWith(
      "/rpc/threads/stop",
      expect.objectContaining({ headers: expect.objectContaining({ cookie: "root-session" }) }),
    );
    expect(f.order.indexOf("disable")).toBeLessThan(f.order.indexOf("stop:root-bot"));
    expect(f.order).toContain("stop:child-bot");
    expect(f.order).toContain("stop:late-child-bot");
    expect(f.cancel).toHaveBeenCalledWith("run:late-child-run");
    expect(f.abort).toHaveBeenCalledWith("late-child-run");
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: "eval-user", spaceId: "eval-space" }] },
      data: { active: false, nextRunAt: null },
    });
  });

  it.each([[{ failDisable: true }], [{ failStop: true }]])(
    "attempts cancellation and fails cleanup after a cleanup operation fails",
    async (options) => {
      const f = fixture(options);
      f.releaseQuietAbort();
      await expect(cleanupActors(f.handles, actors)).rejects.toThrow("could not be stopped");
      expect(f.cancel).toHaveBeenCalledWith("run:root-run");
      expect(f.abort).toHaveBeenCalledWith("root-run");
    },
  );
});
