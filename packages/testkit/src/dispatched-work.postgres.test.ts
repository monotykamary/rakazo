import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime, JobPublisher, MemoryStore } from "@rakazo/adapter-kit";
import type { Actor, WorkReceipt } from "@rakazo/contracts";
import {
  bootstrapUserSpace,
  createDb,
  createRepos,
  createThreadEvents,
  listDispatchedWork,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageBot, returnBotMessageOutcome } from "../../adapters/src/bot-messages.js";
import { DesktopSandboxProvider } from "../../adapters/src/desktop-sandbox.js";
import { dispatchWork } from "../../adapters/src/dispatched-work.js";
import { createRunExecutor } from "../../adapters/src/executor.js";
import { LocalAgentHomeStore } from "../../adapters/src/home.js";
import { createJobReconciler } from "../../adapters/src/job-reconciler.js";
import { EncryptedSecretStore } from "../../adapters/src/secrets.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).each(["team", "dedicated"] as const)(
  "durable dispatched project work on %s (real PostgreSQL)",
  (computerMode) => {
    let db: ReturnType<typeof createDb>;
    let dir: string;
    let actor: Actor;
    let parent: { id: string; threadId: string };
    let sourceRunId: string;
    const receipts: WorkReceipt[] = [];
    const entered = new Set<string>();
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    const requests: AgentRunRequest[] = [];
    let publisherClosed = false;
    let reconciled: string[] = [];
    let executor: ReturnType<typeof createRunExecutor>;
    let events: ReturnType<typeof createThreadEvents>;
    let jobs: JobPublisher;
    const initialCwd = process.cwd();
    const gate = (id: string) => {
      const known = gates.get(id);
      if (known) return known;
      let resolve!: () => void;
      const item = {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        resolve: () => resolve(),
      };
      gates.set(id, item);
      return item;
    };
    const configure = () => {
      events = createThreadEvents(db.prisma);
      jobs = {
        enqueue: async (job) => {
          if (publisherClosed) throw new Error("Fixture publisher stopped");
          if (job.name === "run.continue")
            reconciled.push((job.payload as { runId: string }).runId);
        },
        close: async () => {
          publisherClosed = true;
        },
        cancel: async () => undefined,
      };
      const runtime: AgentRuntime = {
        describe: () => ({
          id: "pi",
          contractVersion: "1",
          adapterVersion: "fixture",
          capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
        }),
        abort: async () => undefined,
        async *run(request) {
          requests.push(request);
          if (request.threadId === parent.threadId) {
            if (request.prompt === "DISPATCH") {
              expect(request.instructions).toContain("builder and coordinator");
              expect(request.tools.some((tool) => tool.name === "spawn_bot")).toBe(true);
              expect(request.tools.some((tool) => tool.name === "dispatch_work")).toBe(true);
              for (const path of ["projects/alpha", "projects/beta"]) {
                expect(
                  await request.executeTool!(
                    "write_file",
                    { path: `${path}/seed.txt`, content: "seed" },
                    `${sourceRunId}:seed:${path}`,
                  ),
                ).not.toHaveProperty("error");
              }
              for (const [name, path] of [
                ["Alpha one", "projects/alpha"],
                ["Alpha two", "projects/alpha"],
                ["Beta", "projects/beta"],
              ]) {
                const input = {
                  name,
                  task: `Complete ${name} and verify the result.`,
                  project_path: name === "Beta" ? "projects/alpha" : path,
                  ...(name === "Beta" ? { worktree_path: path } : {}),
                  tools: ["read_file", "list_files", "write_file"],
                };
                const receipt = (await request.executeTool!(
                  "dispatch_work",
                  input,
                  `${sourceRunId}:dispatch:${name}`,
                )) as WorkReceipt & { ok: boolean };
                expect(receipt).toMatchObject({ ok: true, status: "queued" });
                receipts.push(receipt);
                const replay = await request.executeTool!(
                  "dispatch_work",
                  input,
                  `${sourceRunId}:dispatch:${name}`,
                );
                expect(replay).toMatchObject({
                  id: receipt.id,
                  runId: receipt.runId,
                  workerId: receipt.workerId,
                });
              }
              expect(
                await request.executeTool!(
                  "dispatch_work",
                  { task: "Escape", project_path: "../escape" },
                  "escape-call",
                ),
              ).toHaveProperty("error");
              expect(
                await request.executeTool!(
                  "dispatch_work",
                  { task: "Shell escape", project_path: "projects/alpha", tools: ["shell"] },
                  "shell-call",
                ),
              ).toHaveProperty("error");
              expect(
                await request.executeTool!(
                  "message_bot",
                  { bot_id: receipts[0]!.workerId, message: "Unscoped second task" },
                  "hidden-message",
                ),
              ).toHaveProperty("error");
              yield { type: "done", text: "Queued three project tasks. What next?" };
            } else {
              expect(
                await request.executeTool!(
                  "write_file",
                  { path: "projects/alpha/conflict.txt", content: "must not write" },
                  "parent-conflict",
                ),
              ).toMatchObject({ error: expect.stringContaining("queued or running work") });
              yield { type: "done", text: "Still here while the projects run." };
            }
            return;
          }
          const work = await db.prisma.dispatchedWork.findUniqueOrThrow({
            where: { runId: request.runId },
          });
          expect(request.tools.map((tool) => tool.name).sort()).toEqual([
            "list_files",
            "read_file",
            "write_file",
          ]);
          expect(request.placement?.cwd).toBe(work.worktreePath ?? work.projectPath);
          const coordinatorModel = requests.find(
            (item) => item.threadId === parent.threadId,
          )?.model;
          expect(request.model).toMatchObject({
            provider: coordinatorModel!.provider,
            id: coordinatorModel!.id,
          });
          expect(request.session).toBeDefined();
          await request.session!.save({ version: 1, marker: work.id });
          await expect(
            Promise.resolve().then(() =>
              request.executeTool!(
                "write_file",
                { path: "../outside.txt", content: "no" },
                `${work.id}:escape`,
              ),
            ),
          ).rejects.toThrow("escapes");
          expect(
            await request.executeTool!("computer_act", { actions: [] }, `${work.id}:gui`),
          ).toHaveProperty("error");
          expect(
            await request.executeTool!(
              "shell",
              { command: "cd ..; touch outside" },
              `${work.id}:shell`,
            ),
          ).toHaveProperty("error");
          const written = await request.executeTool!(
            "write_file",
            { path: "result.txt", content: work.id },
            `${work.id}:write`,
          );
          expect(written).not.toHaveProperty("error");
          entered.add(request.runId);
          await gate(request.runId).promise;
          if (receipts.find((item) => item.runId === request.runId)?.name === "Beta")
            throw new Error("Fixture project check failed");
          yield { type: "done", text: `Verified result for ${work.id}.` };
        },
      };
      executor = createRunExecutor({
        prisma: db.prisma,
        events,
        runtime,
        jobs,
        sandbox: new DesktopSandboxProvider({ root: dir }),
        home: new LocalAgentHomeStore(dir),
        memory: {
          read: async () => ({ documents: [] }),
          commit: async () => ({ documents: [] }),
        } as unknown as MemoryStore,
        memoryProviders: { resolve: async () => null },
        deploymentModelKey: "offline-fixture-key",
        secrets: [],
        secretStore: new EncryptedSecretStore("offline-work-fixture-key"),
        dataDir: dir,
      });
    };
    const createRun = async (prompt: string) => {
      const scope = {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: parent.id,
        threadId: parent.threadId,
      };
      const task = await db.prisma.task.create({ data: { ...scope, prompt, status: "queued" } });
      return db.prisma.run.create({
        data: { ...scope, taskId: task.id, status: "queued", trigger: "user" },
      });
    };
    beforeAll(async () => {
      process.env.SANDBOX_PROVIDER = "desktop";
      dir = await mkdtemp(join(tmpdir(), "rakazo-work-proof-"));
      db = createDb(process.env.DATABASE_URL!);
      const user = await db.prisma.user.create({
        data: {
          id: randomUUID(),
          name: "Work fixture",
          email: `work-${randomUUID()}@example.test`,
        },
      });
      const { spaceId } = await bootstrapUserSpace(db.prisma, user, {
        signupsEnabled: "true",
        signupAllowlist: undefined,
      });
      actor = { userId: user.id, spaceId, email: user.email, isDeploymentOwner: false };
      const fixtureSecret = await new EncryptedSecretStore("offline-work-fixture-key").put(
        "offline-fixture-key",
        {
          operationId: "fixture",
          traceId: "fixture",
          userId: user.id,
          spaceId,
          signal: new AbortController().signal,
        },
      );
      await db.prisma.secret.create({ data: { ...fixtureSecret, userId: user.id, kind: "model" } });
      await db.prisma.userModelCredential.create({
        data: {
          userId: user.id,
          provider: "offline",
          label: "Offline fixture",
          secretId: fixtureSecret.id,
        },
      });
      parent = await createRepos(db.prisma).createBot(actor, {
        name: "Chief",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        computerMode,
        modelProvider: "offline",
        modelId: "fixture",
      });
      configure();
    });
    afterAll(async () => {
      for (const item of gates.values()) item.resolve();
      await db?.prisma.$disconnect();
      await db?.pool.end();
      await rm(dir, { recursive: true, force: true });
      process.env.SANDBOX_PROVIDER = "fake";
    });

    it("finishes the parent, survives a cold DB/executor restart, runs independent roots and serializes a shared root", async () => {
      const source = await createRun("DISPATCH");
      sourceRunId = source.id;
      await jobs.close(); // Simulate the dispatch host losing its wake publisher before tool acceptance.
      await executor.continueRun(source.id, "parent-worker");
      expect(
        await db.prisma.run.findUniqueOrThrow({
          where: { id: source.id },
          select: { status: true, error: true },
        }),
      ).toEqual({ status: "completed", error: null });
      expect(receipts).toHaveLength(3);
      expect(await createRepos(db.prisma).listBots(actor)).toHaveLength(1);
      await expect(createRepos(db.prisma).reorderBots(actor, [parent.id])).resolves.toBeUndefined();
      await expect(
        createRepos(db.prisma).setBotComputer(actor, receipts[0]!.workerId, "dedicated"),
      ).rejects.toThrow();
      expect(await listDispatchedWork(db.prisma, actor, parent.id)).toHaveLength(3);
      const parentMessages = await db.prisma.message.findMany({
        where: { threadId: parent.threadId },
      });
      expect(
        parentMessages.filter((message) => JSON.stringify(message.blocks).includes('"work":')),
      ).toHaveLength(3);
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(process.env.DATABASE_URL!); // No old executor/publisher or in-process worker state is reused.
      publisherClosed = false;
      reconciled = [];
      configure();
      await createJobReconciler({ prisma: db.prisma, jobs }).reconcileOnce();
      expect(
        reconciled.filter((id) => receipts.some((receipt) => receipt.runId === id)).sort(),
      ).toEqual(receipts.map((item) => item.runId).sort());

      await db.prisma.bot.update({ where: { id: parent.id }, data: { modelId: "fixture-next" } });
      // Dispatch captured the prior effective model; later coordinator changes cannot retarget work.
      const first = executor.continueRun(receipts[0]!.runId, "worker-alpha");
      let independent = Promise.resolve();
      try {
        await expect
          .poll(
            async () => ({
              entered: entered.has(receipts[0]!.runId),
              run: await db.prisma.run.findUniqueOrThrow({
                where: { id: receipts[0]!.runId },
                select: { status: true, error: true },
              }),
            }),
            { timeout: 3000 },
          )
          .toEqual({ entered: true, run: { status: "running", error: null } });
        independent = executor.continueRun(receipts[2]!.runId, "worker-beta");
        await expect
          .poll(
            async () => ({
              entered: entered.size,
              runs: await db.prisma.run.findMany({
                where: { id: { in: [receipts[0]!.runId, receipts[2]!.runId] } },
                select: { status: true, error: true },
              }),
            }),
            { timeout: 3000 },
          )
          .toEqual({
            entered: 2,
            runs: [
              { status: "running", error: null },
              { status: "running", error: null },
            ],
          });
        await executor.continueRun(receipts[1]!.runId, "worker-conflict");
        expect(entered.has(receipts[1]!.runId)).toBe(false);
        expect(
          (await db.prisma.run.findUniqueOrThrow({ where: { id: receipts[1]!.runId } })).status,
        ).toBe("queued");
        const control = await createRun("CONTROL");
        await executor.continueRun(control.id, "parent-control");
        expect((await db.prisma.run.findUniqueOrThrow({ where: { id: control.id } })).status).toBe(
          "completed",
        );
        expect(entered.size).toBe(2);
      } finally {
        gate(receipts[0]!.runId).resolve();
        gate(receipts[2]!.runId).resolve();
        await Promise.all([first, independent]);
      }
      gate(receipts[1]!.runId).resolve();
      await executor.continueRun(receipts[1]!.runId, "worker-second");
      expect(entered.has(receipts[1]!.runId)).toBe(true);
      const statuses = await listDispatchedWork(db.prisma, actor, parent.id);
      expect(statuses.find((row) => row.name === "Beta")).toMatchObject({
        status: "failed",
        error: "Fixture project check failed",
      });
      expect(statuses.filter((row) => row.status === "completed")).toHaveLength(2);
      for (const receipt of [receipts[1]!, receipts[2]!]) {
        const work = await db.prisma.dispatchedWork.findUniqueOrThrow({
          where: { id: receipt.id },
        });
        const computer = await db.prisma.computer.findUniqueOrThrow({
          where: { id: work.computerId },
        });
        const root = join(computer.providerRef!, work.worktreePath ?? work.projectPath);
        expect(await readFile(join(root, "result.txt"), "utf8")).toBe(work.id);
        await expect(readFile(join(root, "conflict.txt"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      for (const receipt of receipts) {
        const row = await db.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } });
        await returnBotMessageOutcome(
          { prisma: db.prisma, jobs, events },
          row,
          { id: receipt.workerId, name: receipt.name },
          "Duplicate must not arrive.",
        );
        const inbound = await db.prisma.message.findMany({
          where: {
            threadId: parent.threadId,
            clientNonce: `bot-message:auto-outcome:${receipt.runId}`,
          },
        });
        expect(inbound).toHaveLength(1);
      }
      await expect(
        listDispatchedWork(db.prisma, { ...actor, userId: "foreign-owner" }, parent.id),
      ).rejects.toThrow();
      expect(process.cwd()).toBe(initialCwd);
    }, 30000);

    it("recovers acceptance/outcome-marker crashes and reports cancellation once", async () => {
      const placement = await db.prisma.dispatchedWork.findUniqueOrThrow({
        where: { id: receipts[0]!.id },
      });
      const source = await createRun("Cancelled project fixture");
      await db.prisma.run.update({ where: { id: source.id }, data: { status: "running" } });
      const input = {
        task: "Prepare a report; do not run commands.",
        name: "Cancelled report",
        project_path: placement.projectPath,
        tools: ["read_file"],
      };
      const target = {
        computerId: placement.computerId,
        homeKey: placement.homeKey,
        projectPath: placement.projectPath,
      };
      const [accepted, raced] = await Promise.all([
        dispatchWork(
          { prisma: db.prisma, jobs, events },
          source,
          input,
          `${source.id}:once`,
          target,
        ),
        dispatchWork(
          { prisma: db.prisma, jobs, events },
          source,
          input,
          `${source.id}:once`,
          target,
        ),
      ]);
      expect(raced).toMatchObject({
        id: accepted.id,
        runId: accepted.runId,
        workerId: accepted.workerId,
      });
      expect(
        await db.prisma.dispatchedWork.count({ where: { requestKey: `${source.id}:once` } }),
      ).toBe(1);
      await expect(
        dispatchWork(
          { prisma: db.prisma, jobs, events },
          { ...source, userId: "foreign-owner" },
          input,
          `${source.id}:once`,
          target,
        ),
      ).rejects.toThrow("another scope");
      expect(
        await messageBot(
          { prisma: db.prisma, jobs, events },
          source,
          { id: parent.id, name: "Chief" },
          { bot_id: accepted.workerId, message: "A second unscoped task" },
        ),
      ).toHaveProperty("error");
      await db.prisma.run.update({
        where: { id: accepted.runId },
        data: { status: "cancelled", completedAt: new Date() },
      });
      await db.prisma.run.update({
        where: { id: source.id },
        data: { status: "completed", completedAt: new Date() },
      });
      const reconciler = createJobReconciler({ prisma: db.prisma, jobs, events });
      await reconciler.reconcileOnce();
      const nonce = `bot-message:auto-outcome:${accepted.runId}`;
      const outcomes = () =>
        db.prisma.message.findMany({ where: { threadId: parent.threadId, clientNonce: nonce } });
      expect({
        outcomes: (await outcomes()).length,
        terminal: await db.prisma.run.findUnique({
          where: { id: accepted.runId },
          select: { sourceMessageId: true, botOutcomeReturnedAt: true, status: true },
        }),
      }).toMatchObject({
        outcomes: 1,
        terminal: {
          sourceMessageId: expect.any(String),
          botOutcomeReturnedAt: expect.any(Date),
          status: "cancelled",
        },
      });
      expect(JSON.stringify((await outcomes())[0]!.blocks)).toContain("cancelled");
      // A crash after delivery but before the bookkeeping marker must not redeliver.
      await db.prisma.run.update({
        where: { id: accepted.runId },
        data: { botOutcomeReturnedAt: null },
      });
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(process.env.DATABASE_URL!);
      configure();
      await createJobReconciler({ prisma: db.prisma, jobs, events }).reconcileOnce();
      expect(await outcomes()).toHaveLength(1);
      expect(
        (await db.prisma.run.findUniqueOrThrow({ where: { id: accepted.runId } }))
          .botOutcomeReturnedAt,
      ).not.toBeNull();
    });

    it("refuses changed computer authority before a temporary worker starts", async () => {
      const placement = await db.prisma.dispatchedWork.findUniqueOrThrow({
        where: { id: receipts[0]!.id },
      });
      const source = await createRun("Authority fixture");
      await db.prisma.run.update({ where: { id: source.id }, data: { status: "running" } });
      const accepted = await dispatchWork(
        { prisma: db.prisma, jobs, events },
        source,
        {
          task: "Stay within the captured project.",
          project_path: placement.projectPath,
          tools: ["read_file"],
        },
        `${source.id}:authority`,
        {
          computerId: placement.computerId,
          homeKey: placement.homeKey,
          projectPath: placement.projectPath,
        },
      );
      await db.prisma.run.update({
        where: { id: source.id },
        data: { status: "completed", completedAt: new Date() },
      });
      await db.prisma.bot.update({ where: { id: parent.id }, data: { computerSwitching: true } });
      try {
        const before = requests.length;
        await executor.continueRun(accepted.runId, "worker-wrong-authority");
        expect(requests).toHaveLength(before);
        expect(
          await db.prisma.run.findUniqueOrThrow({
            where: { id: accepted.runId },
            select: { status: true, error: true },
          }),
        ).toMatchObject({ status: "failed", error: expect.stringContaining("authority changed") });
        expect(
          await db.prisma.message.count({
            where: {
              threadId: parent.threadId,
              clientNonce: `bot-message:auto-outcome:${accepted.runId}`,
            },
          }),
        ).toBe(1);
      } finally {
        await db.prisma.bot.update({
          where: { id: parent.id },
          data: { computerSwitching: false },
        });
      }
    });

    it("rejects hidden automatic/explicit pins and reports a newly hidden queued pin without fallback", async () => {
      const placement = await db.prisma.dispatchedWork.findUniqueOrThrow({
        where: { id: receipts[0]!.id },
      });
      const source = await createRun("Visibility fixture");
      await db.prisma.run.update({
        where: { id: source.id },
        data: { status: "running", modelProvider: "offline", modelId: "fixture" },
      });
      const input = {
        task: "Use the chosen model only.",
        project_path: placement.projectPath,
        tools: ["read_file"],
      };
      const target = {
        computerId: placement.computerId,
        homeKey: placement.homeKey,
        projectPath: placement.projectPath,
      };
      await db.prisma.user.update({
        where: { id: actor.userId },
        data: { modelVisibility: { hide: [{ provider: "offline" }] } },
      });
      const before = await db.prisma.bot.count({
        where: { userId: actor.userId, temporary: true },
      });
      try {
        await expect(
          dispatchWork(
            { prisma: db.prisma, jobs, events },
            source,
            input,
            `${source.id}:auto-hidden`,
            target,
          ),
        ).rejects.toThrow("hidden");
        await expect(
          dispatchWork(
            { prisma: db.prisma, jobs, events },
            source,
            { ...input, model: { provider: "offline", modelId: "fixture", thinkingLevel: null } },
            `${source.id}:explicit-hidden`,
            target,
          ),
        ).rejects.toThrow("hidden");
        expect(
          await db.prisma.bot.count({ where: { userId: actor.userId, temporary: true } }),
        ).toBe(before);
      } finally {
        await db.prisma.user.update({
          where: { id: actor.userId },
          data: { modelVisibility: { hide: [] } },
        });
      }
      const accepted = await dispatchWork(
        { prisma: db.prisma, jobs, events },
        source,
        { ...input, model: { provider: "offline", modelId: "fixture", thinkingLevel: "low" } },
        `${source.id}:visible`,
        target,
      );
      expect(
        await db.prisma.bot.findUnique({
          where: { id: accepted.workerId },
          select: { modelProvider: true, modelId: true, thinkingLevel: true },
        }),
      ).toEqual({ modelProvider: "offline", modelId: "fixture", thinkingLevel: "low" });
      await db.prisma.run.update({
        where: { id: source.id },
        data: { status: "completed", completedAt: new Date() },
      });
      await db.prisma.user.update({
        where: { id: actor.userId },
        data: { modelVisibility: { hide: [{ provider: "offline", model: "fixture" }] } },
      });
      try {
        const enteredBefore = requests.length;
        await executor.continueRun(accepted.runId, "worker-hidden-model");
        expect(requests).toHaveLength(enteredBefore);
        expect(
          await db.prisma.run.findUniqueOrThrow({
            where: { id: accepted.runId },
            select: { status: true, error: true },
          }),
        ).toMatchObject({ status: "failed", error: expect.stringContaining("hidden") });
        expect(
          await db.prisma.message.count({
            where: {
              threadId: parent.threadId,
              clientNonce: `bot-message:auto-outcome:${accepted.runId}`,
            },
          }),
        ).toBe(1);
        expect(await db.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(
          1,
        );
      } finally {
        await db.prisma.user.update({
          where: { id: actor.userId },
          data: { modelVisibility: { hide: [] } },
        });
      }
    });
  },
);
