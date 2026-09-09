import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  createMachineFetch,
  createMachineRouting,
  createMachinesService,
  LocalAgentHomeStore,
  provisionComputer,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { createDb, createPrismaMachineScopeResolver, createPrismaMachineStore } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runForwarder } from "../../../packages/runner/src/forwarder.js";
import { TunnelClient } from "../../../packages/runner/src/tunnel-client.js";
import { assignBotMachine, mountMachineRunnerRoutes } from "./machines.js";

const postgres = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

postgres(
  "machine routing through real PostgreSQL, HTTP, and the runner",
  { concurrent: false },
  () => {
    const id = `machine-roundtrip-${randomUUID()}`;
    const actor: Actor = {
      userId: `${id}-user`,
      spaceId: `${id}-space`,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    let db: ReturnType<typeof createDb>;
    let root: string;
    let server: ReturnType<typeof serve>;
    let origin: string;
    let machines: ReturnType<typeof createMachinesService>;
    const controllers: AbortController[] = [];
    const runners: Promise<void>[] = [];

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "rakazo-machine-roundtrip-"));
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.create({
        data: { id: actor.userId, name: "Roundtrip fixture", email: actor.email },
      });
      await db.prisma.organization.create({
        data: { id, name: "Roundtrip fixture", slug: id, createdAt: new Date() },
      });
      await db.prisma.space.create({
        data: { id: actor.spaceId, organizationId: id, name: "Roundtrip fixture" },
      });
      machines = createMachinesService({
        store: createPrismaMachineStore(db.prisma),
        limits: { commandTtlMs: 10_000 },
      });
      const app = new Hono();
      mountMachineRunnerRoutes(app, { machines });
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
          origin = `http://127.0.0.1:${address.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(runners);
      if (server)
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          if ("closeAllConnections" in server) server.closeAllConnections();
        });
      if (db) {
        await db.prisma.organization.deleteMany({ where: { id } });
        await db.prisma.user.deleteMany({ where: { id: actor.userId } });
        await db.prisma.$disconnect();
        await db.pool.end();
      }
      if (root) await rm(root, { recursive: true, force: true });
    });

    async function pairedMachine(name: string) {
      const pairing = await machines.startPairing(actor, { name });
      const paired = await TunnelClient.pair(origin, { code: pairing.code });
      const home = join(root, name, "runner");
      const dataDir = join(root, name, "data");
      await mkdir(home, { recursive: true });
      const controller = new AbortController();
      controllers.push(controller);
      const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> =
        [];
      const files = new Map<string, string>();
      const computers = new Map<
        string,
        { homeKey: string; files: Map<string, string>; running: boolean }
      >();
      const frames = new Map<string, Array<{ seq: number; channel: string; data: string }>>();
      const localFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        expect(request.headers.get("authorization")).toBe("Bearer local-supervisor-fixture");
        const text = request.body ? await request.text() : "";
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        calls.push({ method: request.method, path: url.pathname, body });
        if (url.pathname === "/computers") {
          expect(body?.homePath).toBe(join(dataDir, "homes", String(body?.botId)));
          const homeKey = String(body?.botId);
          const existing = [...computers].find(([, computer]) => computer.homeKey === homeKey);
          if (existing) {
            existing[1].running = true;
            return Response.json({ id: existing[0], resumed: true });
          }
          const containerId = `container-${name}${computers.size ? `-${computers.size}` : ""}`;
          computers.set(containerId, {
            homeKey,
            files: computers.size ? new Map() : files,
            running: true,
          });
          return Response.json({ id: containerId, resumed: false });
        }
        const computer = computers.get(url.pathname.split("/")[2]!);
        if (url.pathname.endsWith("/services") && computer) {
          return Response.json({ supported: true, services: [] });
        }
        if (url.pathname.endsWith("/stop") && computer) {
          computer.running = false;
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/files")) {
          if (!computer) return Response.json({ error: "Unknown computer" }, { status: 404 });
          const files = computer.files;
          if (request.method === "POST") {
            files.set(String(body?.path), String(body?.content));
            return Response.json({ ok: true });
          }
          if (url.searchParams.get("mode") === "read") {
            return Response.json({ content: files.get(url.searchParams.get("path")!) ?? "" });
          }
          return Response.json(
            [...files.keys()].map((path) => ({
              path,
              kind: "file",
              size: Buffer.from(files.get(path)!, "base64").length,
            })),
          );
        }
        if (url.pathname === "/agents") {
          const agent = `agent-${name}-${frames.size}`;
          frames.set(agent, []);
          return Response.json({ id: agent });
        }
        const agent = url.pathname.split("/")[2]!;
        if (url.pathname.endsWith("/input")) {
          const output = frames.get(agent)!;
          output.push({
            seq: output.length,
            channel: String(body?.channel),
            data: String(body?.data),
          });
          return Response.json({ ok: true });
        }
        if (url.pathname.endsWith("/events")) {
          await sleep(30, undefined, { signal: request.signal });
          const output = frames.get(agent)!;
          const cursor = Number(url.searchParams.get("cursor"));
          return Response.json({
            frames: output.filter((frame) => frame.seq > cursor),
            cursor: output.length - 1,
            closed: false,
          });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ error: "Unexpected fixture route" }, { status: 404 });
      };
      const running = runForwarder({
        credentials: { machineId: paired.machineId, machineToken: paired.token, serverUrl: origin },
        home,
        supervisor: {
          baseUrl: "http://local-supervisor.invalid",
          token: "local-supervisor-fixture",
          dataDir,
          fetch: localFetch,
        },
        client: new TunnelClient({ serverUrl: origin }),
        signal: controller.signal,
        pollIntervalMs: 10,
        longPollWaitMs: 100,
      });
      runners.push(running);
      return { ...paired, calls, files, computers };
    }

    async function botOn(machineId: string, name: string) {
      const computer = await db.prisma.computer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          scope: "dedicated",
          scopeKey: `${id}-${name}`,
          homeKey: `${id}-${name}`,
          machineId,
          kind: "machine",
          state: "stopped",
        },
      });
      const bot = await db.prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name,
          color: "test",
          computerId: computer.id,
        },
      });
      const thread = await db.prisma.thread.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "fixture",
          status: "running",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
          leaseOwner: "roundtrip-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const context: AdapterContext = {
        ...actor,
        botId: bot.id,
        runId: run.id,
        runLease: { owner: "roundtrip-worker", fence: 1 },
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      };
      return { computer, bot, thread, run, context };
    }

    it("boots the newest workspace after moving away and back without resuming stale files", async () => {
      const first = await pairedMachine("move-a");
      const second = await pairedMachine("move-b");
      const scope = await botOn(first.machineId, "move-home");
      scope.computer = await db.prisma.computer.update({
        where: { id: scope.computer.id },
        data: {
          scopeKey: `machine:${first.machineId}:${scope.bot.id}`,
          homeKey: `machine-${first.machineId}-${scope.bot.id}`,
        },
      });
      await db.prisma.run.update({
        where: { id: scope.run.id },
        data: { status: "succeeded", leaseOwner: null, leaseExpiresAt: null },
      });
      const context: AdapterContext = {
        ...actor,
        botId: scope.bot.id,
        operationId: "move-probe",
        traceId: "move-probe",
        signal: new AbortController().signal,
      };
      const routing = createMachineRouting({
        prisma: db.prisma,
        machineFetch: (machineId) =>
          createMachineFetch(machines, machineId, {
            scopeResolver: createPrismaMachineScopeResolver(db.prisma, machineId),
          }),
      });
      const home = new LocalAgentHomeStore(join(root, "move-server"));
      const deps = { prisma: db.prisma, sandbox: routing.sandbox, home };
      await home.writeFile(scope.computer.homeKey, "project/source.txt", "original", context);
      const originalRef = await provisionComputer(deps, scope.computer.id, context);
      await assignBotMachine(deps, actor, { botId: scope.bot.id, machineId: second.machineId });
      const onB = await db.prisma.bot.findUniqueOrThrow({
        where: { id: scope.bot.id },
        include: { computer: true },
      });
      const refB = await provisionComputer(deps, onB.computer!.id, context);
      await routing.sandbox.writeFile(
        refB,
        { path: "project/new.txt", content: new TextEncoder().encode("newest"), executable: false },
        context,
      );
      await assignBotMachine(deps, actor, { botId: scope.bot.id, machineId: first.machineId });
      const returned = await db.prisma.bot.findUniqueOrThrow({
        where: { id: scope.bot.id },
        include: { computer: true, thread: true },
      });
      const returnedRef = await provisionComputer(deps, returned.computer!.id, context);
      expect(
        new TextDecoder().decode(
          await routing.sandbox.readFile(returnedRef, "project/new.txt", context),
        ),
      ).toBe("newest");
      expect(
        new TextDecoder().decode(
          await routing.sandbox.readFile(returnedRef, "project/source.txt", context),
        ),
      ).toBe("original");
      expect(returned.computerId).not.toBe(scope.computer.id);
      expect(returned.computer!.homeKey).not.toBe(scope.computer.homeKey);
      expect(returnedRef.providerRef).not.toBe(originalRef.providerRef);
      expect(returned.thread!.id).toBe(scope.thread.id);
      expect(first.computers.size).toBe(2);
      expect(second.computers.size).toBe(1);
      expect(first.computers.get("container-move-a")?.running).toBe(false);
      expect(second.computers.get("container-move-b")?.running).toBe(false);
      expect(first.calls.some((call) => call.path === "/computers/container-move-a/stop")).toBe(
        true,
      );
      const old = await db.prisma.computer.findUniqueOrThrow({ where: { id: scope.computer.id } });
      expect(toComputerRef(old).providerRef).toBe(originalRef.providerRef);
      expect(first.computers.get("container-move-a")?.files.get("project/source.txt")).toBe(
        Buffer.from("original").toString("base64"),
      );
    });
    it("rejects a stale provisional boot at delivery and result acceptance", async () => {
      const pairing = await machines.startPairing(actor, { name: "staging" });
      const { machineId } = await TunnelClient.pair(origin, { code: pairing.code });
      const scope = await botOn(machineId, "staging");
      const headers = {
        "x-rakazo-bot-id": scope.computer.homeKey,
        "x-rakazo-space-id": actor.spaceId,
        "x-rakazo-run-id": scope.run.id,
        "x-rakazo-lease-owner": "roundtrip-worker",
        "x-rakazo-lease-fence": "1",
      };
      const resolver = createPrismaMachineScopeResolver(db.prisma, machineId);
      const path = "/computers/container-staging/files";
      await db.prisma.computer.update({
        where: { id: scope.computer.id },
        data: { state: "booting", updatedAt: new Date(Date.now() - 1000) },
      });
      const captured = await resolver({ path, headers });
      const first = await machines.enqueue({
        machineId,
        method: "POST",
        path,
        headers,
        scope: captured,
      });
      await db.prisma.computer.update({
        where: { id: scope.computer.id },
        data: { updatedAt: new Date(first.createdAt.getTime() + 1000) },
      });
      expect(await machines.poll({ machineId })).toBeNull();
      expect(
        (await db.prisma.machineCommand.findUniqueOrThrow({ where: { id: first.id } })).status,
      ).toBe("aborted");

      await db.prisma.computer.update({
        where: { id: scope.computer.id },
        data: { updatedAt: new Date(Date.now() - 1000) },
      });
      const second = await machines.enqueue({
        machineId,
        method: "POST",
        path,
        headers,
        scope: captured,
      });
      expect((await machines.poll({ machineId }))?.id).toBe(second.id);
      await db.prisma.computer.update({
        where: { id: scope.computer.id },
        data: { updatedAt: new Date(second.createdAt.getTime() + 1000) },
      });
      await expect(
        machines.complete({
          machineId,
          commandId: second.id,
          response: { status: 200, contentType: null, bodyBase64: null },
        }),
      ).resolves.toBe("aborted");

      await expect(
        resolver({
          path: `/computers/${scope.computer.id}/files`,
          headers: { ...headers, "x-rakazo-space-id": "foreign" },
        }),
      ).rejects.toThrow("space");
      await expect(
        resolver({
          path: `/computers/${scope.computer.id}/files`,
          headers: { ...headers, "x-rakazo-bot-id": "foreign" },
        }),
      ).rejects.toThrow("home key");
    });

    it("restores a fresh machine before activation, routes two machines, and carries root/child RPC without local fallback", async () => {
      const first = await pairedMachine("first");
      const second = await pairedMachine("second");
      const routing = createMachineRouting({
        prisma: db.prisma,
        machineFetch: (machineId) =>
          createMachineFetch(machines, machineId, {
            scopeResolver: createPrismaMachineScopeResolver(db.prisma, machineId),
          }),
      });
      const home = new LocalAgentHomeStore(join(root, "server"));
      for (const machine of [first, second]) {
        const scope = await botOn(machine.machineId, machine === first ? "one" : "two");
        await home.writeFile(scope.computer.homeKey, "seed.txt", scope.bot.name, scope.context);
        const ref = await provisionComputer(
          { prisma: db.prisma, sandbox: routing.sandbox, home },
          scope.computer.id,
          scope.context,
        );
        expect(ref.kind).toBe("machine");
        expect(
          new TextDecoder().decode(await routing.sandbox.readFile(ref, "seed.txt", scope.context)),
        ).toBe(scope.bot.name);
        expect(machine.files.get("seed.txt")).toBe(Buffer.from(scope.bot.name).toString("base64"));
        for (const runId of [scope.run.id, `${scope.run.id}.child`]) {
          const connection = await routing.host.start(
            {
              runId,
              rootRunId: scope.run.id,
              threadId: scope.thread.id,
              botId: scope.bot.id,
              spaceId: actor.spaceId,
              leaseOwner: "roundtrip-worker",
              leaseFence: 1,
            },
            scope.context.signal,
          );
          try {
            const message = new TextEncoder().encode('{"type":"fixture"}\n');
            await connection.rpc.write(message);
            const next = await connection.rpc.incoming[Symbol.asyncIterator]().next();
            expect(next.value).toEqual(message);
          } finally {
            await connection.stop();
          }
        }
        expect(machine.calls.filter((call) => call.path === "/computers")).toHaveLength(1);
        expect(machine.calls.filter((call) => call.path === "/agents")).toHaveLength(2);
      }
      expect(first.files.get("seed.txt")).not.toBe(second.files.get("seed.txt"));
    });
  },
);
