import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import { FakeSandboxProvider, LocalAgentHomeStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  bootstrapUserSpace,
  claimDispatchedWork,
  createDb,
  createRepos,
  WorkScopeError,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assignBotMachine } from "./machines.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

const context: AdapterContext = {
  operationId: "relocation-test",
  traceId: "relocation-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const enc = (text: string) => new TextEncoder().encode(text);
const file = (path: string, content: string): PortableFile => ({
  path,
  content: enc(content),
  executable: false,
});

const SEED_FILES = [
  file(".git/HEAD", "ref: refs/heads/main"),
  file(".pi/agent/session.json", '{"identity":true}'),
  file("projects/alpha/README.md", "alpha"),
  file("projects/beta/src/index.ts", "beta"),
  file("notes.txt", "portable"),
];

describeDatabase("verified workspace relocation (PostgreSQL)", { concurrent: false }, () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let home: LocalAgentHomeStore;
  let sandbox: FakeSandboxProvider;
  let homeRoot: string;
  let actor: Actor;
  let machineA: { id: string };
  let machineB: { id: string };
  let foreignMachine: { id: string };

  const deps = () => ({ prisma, sandbox, home, defaultComputerKind: "e2b" });

  const makeBot = async (computerMode: "dedicated" | "team" = "dedicated") => {
    const bot = await createRepos(prisma).createBot(actor, {
      name: `Relocator ${randomUUID().slice(0, 8)}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      computerMode,
    });
    return bot;
  };

  const computerOf = async (botId: string) => {
    const bot = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { computer: true, thread: true },
    });
    return { ...bot, threadId: bot.thread.id };
  };

  const seedHome = async (key: string, files: PortableFile[]) => {
    for (const f of files) {
      await home.writeFile(key, f.path, new TextDecoder().decode(f.content), context);
    }
  };

  const homePaths = async (key: string) => {
    const paths: string[] = [];
    for await (const f of home.exportHome(key, context)) paths.push(f.path);
    return paths.sort();
  };

  const fillBox = async (boxId: string, files: PortableFile[]) => {
    await sandbox.provision({ botId: boxId.slice("fake-".length), homePath: "/unused" }, context);
    const ref = { id: boxId, botId: boxId, kind: "machine" as const, providerRef: boxId };
    for (const f of files) await sandbox.writeFile(ref, f, context);
  };

  const materializeMachineSource = async (
    computerId: string,
    boxId: string,
    files: PortableFile[],
  ) => {
    await fillBox(boxId, files);
    await prisma.computer.update({
      where: { id: computerId },
      data: { providerRef: boxId, kind: "machine", state: "running", homeRevision: "rev-check" },
    });
  };

  const makeRun = async (
    bot: { id: string; threadId: string },
    status: string,
  ): Promise<{ id: string }> => {
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: bot.threadId,
        userId: actor.userId,
        prompt: "fixture",
        status: "queued",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: bot.threadId,
        taskId: task.id,
        userId: actor.userId,
        status,
        trigger: "user",
      },
    });
  };

  beforeAll(async () => {
    homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-relocation-"));
    home = new LocalAgentHomeStore(homeRoot);
    sandbox = new FakeSandboxProvider();
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: "Relocation fixture",
        email: `relocate-${randomUUID()}@example.test`,
      },
    });
    const { spaceId } = await bootstrapUserSpace(prisma, user, {
      signupsEnabled: "true",
      signupAllowlist: undefined,
    });
    actor = { userId: user.id, spaceId, email: user.email, isDeploymentOwner: false };
    context.spaceId = spaceId;
    context.userId = user.id;
    const other = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: "Foreign owner",
        email: `foreign-${randomUUID()}@example.test`,
      },
    });
    const mkMachine = async (userId: string) =>
      prisma.machine.create({
        data: {
          spaceId,
          userId,
          name: "laptop",
          status: "paired",
          credentialHash: `hash-${randomUUID()}`,
        },
        select: { id: true },
      });
    machineA = await mkMachine(user.id);
    machineB = await mkMachine(user.id);
    foreignMachine = await mkMachine(other.id);
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await rm(homeRoot, { recursive: true, force: true });
  });

  it("copies an unbooted home even before its first revision is recorded", async () => {
    const bot = await makeBot();
    const source = await computerOf(bot.id);
    await seedHome(source.computer!.homeKey, [file("unrecorded.txt", "keep me")]);
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const moved = await computerOf(bot.id);
    expect(await homePaths(moved.computer!.homeKey)).toContain("unrecorded.txt");
    expect(await homePaths(source.computer!.homeKey)).toContain("unrecorded.txt");
  });

  it("does not switch placement or claim a stop succeeded when stopping fails", async () => {
    const bot = await makeBot();
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const source = await computerOf(bot.id);
    await materializeMachineSource(source.computer!.id, "fake-stop-failure", SEED_FILES);
    const stopper = vi.spyOn(sandbox, "stop").mockRejectedValue(new Error("uncertain stop"));
    try {
      await expect(
        assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id }),
      ).rejects.toThrow("could not be stopped");
    } finally {
      stopper.mockRestore();
    }
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.id).toBe(source.computer!.id);
    expect(unchanged.computer!.state).toBe("failed");
    expect(unchanged.computerSwitching).toBe(false);
    expect(sandbox.boxes.get("fake-stop-failure")!.running).toBe(true);
  });

  it("refuses a checkpoint while supervised services can still write to the workspace", async () => {
    const bot = await makeBot();
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const source = await computerOf(bot.id);
    await materializeMachineSource(source.computer!.id, "fake-service-busy", SEED_FILES);
    Object.assign(sandbox, {
      services: {
        list: async () => ({ supported: true, services: [{ name: "web", status: "running" }] }),
      },
    });
    try {
      await expect(
        assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id }),
      ).rejects.toThrow("services before moving");
    } finally {
      Reflect.deleteProperty(sandbox, "services");
    }
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.id).toBe(source.computer!.id);
    expect(unchanged.computer!.state).toBe("running");
    expect(unchanged.computerSwitching).toBe(false);
  });
  it("moves default -> machine A -> machine B -> default with verified copies", async () => {
    const bot = await makeBot();
    const initial = await computerOf(bot.id);
    const defaultRowId = initial.computer!.id;
    await seedHome(initial.computer!.homeKey, SEED_FILES);
    await prisma.computer.update({
      where: { id: defaultRowId },
      data: { homeRevision: "rev-seed" },
    });

    const toA = await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    expect(toA).toMatchObject({ botId: bot.id, machineId: machineA.id });
    const afterA = await computerOf(bot.id);
    expect(afterA.computer!.scopeKey).toBe(`machine:${machineA.id}:${bot.id}`);
    expect(afterA.computer!.homeKey).toMatch(new RegExp(`^machine-${machineA.id}-${bot.id}-`));
    expect(afterA.computer!.homeRevision).not.toBe("empty");
    expect(afterA.computer!.machineId).toBe(machineA.id);
    expect(afterA.computer!.state).toBe("stopped");
    expect(afterA.computer!.providerRef).toBeNull();
    expect(afterA.computerSwitching).toBe(false);
    const onA = await homePaths(afterA.computer!.homeKey);
    expect(onA).toEqual(SEED_FILES.map((f) => f.path).sort());
    expect(await homePaths(initial.computer!.homeKey)).toEqual(
      SEED_FILES.map((f) => f.path).sort(),
    );

    await materializeMachineSource(afterA.computer!.id, "fake-box-a", [
      ...SEED_FILES,
      file(".pi/agent/memory.json", '{"session":"continued"}'),
    ]);
    const toB = await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id });
    expect(toB.machineId).toBe(machineB.id);
    const afterB = await computerOf(bot.id);
    expect(afterB.computer!.homeKey).toMatch(new RegExp(`^machine-${machineB.id}-${bot.id}-`));
    const onB = await homePaths(afterB.computer!.homeKey);
    expect(onB).toContain(".pi/agent/memory.json");
    expect(onB).toContain("projects/alpha/README.md");
    const rowA = await prisma.computer.findUniqueOrThrow({ where: { id: afterA.computer!.id } });
    expect(rowA.state).toBe("stopped");
    expect(rowA.providerRef).toBe("fake-box-a");
    expect(sandbox.boxes.get("fake-box-a")!.running).toBe(false);

    await materializeMachineSource(afterB.computer!.id, "fake-box-b", [
      ...SEED_FILES,
      file(".pi/agent/memory.json", '{"session":"continued"}'),
      file("projects/gamma/new.md", "gamma"),
    ]);
    const backHome = await assignBotMachine(deps(), actor, { botId: bot.id, machineId: null });
    expect(backHome).toMatchObject({ botId: bot.id, machineId: null });
    const afterHome = await computerOf(bot.id);
    expect(afterHome.computer!.id).not.toBe(defaultRowId);
    expect(
      (await prisma.computer.findUniqueOrThrow({ where: { id: defaultRowId } })).scopeKey,
    ).toMatch(/^retired:/);
    expect(afterHome.computer!.homeKey.startsWith(`${bot.id}-`)).toBe(true);
    expect(afterHome.computer!.homeRevision).not.toBe("empty");
    const finalPaths = await homePaths(afterHome.computer!.homeKey);
    expect(finalPaths).toContain("projects/gamma/new.md");
    expect(finalPaths).toContain(".pi/agent/session.json");
    expect(afterHome.computerSwitching).toBe(false);
    const rowB = await prisma.computer.findUniqueOrThrow({ where: { id: afterB.computer!.id } });
    expect(rowB.state).toBe("stopped");
    expect(sandbox.boxes.get("fake-box-b")!.running).toBe(false);
  });

  it("restores the original assignment and files when the checkpoint fails", async () => {
    const bot = await makeBot();
    const seeded = await computerOf(bot.id);
    await seedHome(seeded.computer!.homeKey, SEED_FILES);
    await prisma.computer.update({
      where: { id: seeded.computer!.id },
      data: { homeRevision: "rev-seed" },
    });
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const onA = await computerOf(bot.id);
    await materializeMachineSource(onA.computer!.id, "fake-box-fail", [
      ...SEED_FILES,
      file("projects/inflight.txt", "mid-move"),
    ]);
    const exporter = vi.spyOn(sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield* [];
      throw new Error("machine went offline");
    });
    try {
      await expect(
        assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      exporter.mockRestore();
    }
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.id).toBe(onA.computer!.id);
    expect(unchanged.computer!.machineId).toBe(machineA.id);
    expect(unchanged.computer!.state).toBe("running");
    expect(unchanged.computerSwitching).toBe(false);
    // The failed checkpoint never landed: the durable home keeps its last good
    // copy and the target home key stays empty.
    const homeA = await homePaths(onA.computer!.homeKey);
    expect(homeA).toContain("projects/alpha/README.md");
    expect(homeA).not.toContain("projects/inflight.txt");
    expect(await homePaths(`machine-${machineB.id}-${bot.id}`)).toEqual([]);
  });

  it("refuses to silently empty a materialized workspace", async () => {
    const bot = await makeBot();
    const seeded = await computerOf(bot.id);
    await prisma.computer.update({
      where: { id: seeded.computer!.id },
      data: { homeRevision: "rev-empty" },
    });
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const onA = await computerOf(bot.id);
    await materializeMachineSource(onA.computer!.id, "fake-box-empty", []);
    await expect(
      assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id }),
    ).rejects.toThrow(/empty/i);
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.machineId).toBe(machineA.id);
    expect(unchanged.computer!.state).toBe("running");
    expect(unchanged.computerSwitching).toBe(false);
  });

  it("refuses busy computers: own run, live worker, foreign lease, user control", async () => {
    const withRun = await makeBot();
    const runBot = await computerOf(withRun.id);
    await makeRun({ id: withRun.id, threadId: runBot.threadId! }, "running");
    await expect(
      assignBotMachine(deps(), actor, { botId: withRun.id, machineId: machineA.id }),
    ).rejects.toThrow(/active work/i);
    expect((await computerOf(withRun.id)).computerSwitching).toBe(false);

    const withWorker = await makeBot();
    const workerHost = await computerOf(withWorker.id);
    const worker = await createRepos(prisma).createBot(actor, {
      name: "Worker",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      temporary: true,
      parentBotId: withWorker.id,
      spawnKey: `work:${randomUUID()}`,
    });
    await prisma.bot.update({
      where: { id: worker.id },
      data: { computerId: workerHost.computer!.id },
    });
    const workerRun = await makeRun({ id: worker.id, threadId: worker.threadId }, "running");
    await prisma.dispatchedWork.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        parentBotId: withWorker.id,
        parentThreadId: workerHost.threadId!,
        parentRunId: workerRun.id,
        workerBotId: worker.id,
        taskId: (await prisma.run.findUniqueOrThrow({ where: { id: workerRun.id } })).taskId,
        runId: workerRun.id,
        computerId: workerHost.computer!.id,
        homeKey: workerHost.computer!.homeKey,
        projectPath: "projects/alpha",
        tools: [],
        requestKey: `work:${randomUUID()}`,
      },
    });
    await expect(
      assignBotMachine(deps(), actor, { botId: withWorker.id, machineId: machineA.id }),
    ).rejects.toThrow(/workers are still using/i);
    expect((await computerOf(withWorker.id)).computer!.id).toBe(workerHost.computer!.id);

    const withLease = await makeBot();
    const leaseHost = await computerOf(withLease.id);
    await prisma.computerExecutionLease.create({
      data: {
        computerId: leaseHost.computer!.id,
        botId: "some-peer-bot",
        runId: "peer-run",
        fence: 2,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      assignBotMachine(deps(), actor, { botId: withLease.id, machineId: machineA.id }),
    ).rejects.toThrow(/workers are still using/i);

    const withControl = await makeBot();
    const controlHost = await computerOf(withControl.id);
    await prisma.computer.update({
      where: { id: controlHost.computer!.id },
      data: {
        controlHolder: "user",
        controlLeaseId: "lease-1",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      assignBotMachine(deps(), actor, { botId: withControl.id, machineId: machineA.id }),
    ).rejects.toThrow(/release the computer/i);
  });

  it("holds queued dispatched work in place and rejects its claim after the move", async () => {
    const parent = await makeBot();
    const host = await computerOf(parent.id);
    await seedHome(host.computer!.homeKey, SEED_FILES);
    await prisma.computer.update({
      where: { id: host.computer!.id },
      data: { homeRevision: "rev-seed" },
    });
    const worker = await createRepos(prisma).createBot(actor, {
      name: "Queued worker",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      temporary: true,
      parentBotId: parent.id,
      spawnKey: `work:${randomUUID()}`,
    });
    await prisma.bot.update({
      where: { id: worker.id },
      data: { computerId: host.computer!.id },
    });
    const queuedRun = await makeRun({ id: worker.id, threadId: worker.threadId }, "queued");
    const queuedTask = await prisma.run.findUniqueOrThrow({ where: { id: queuedRun.id } });
    const binding = await prisma.dispatchedWork.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        parentBotId: parent.id,
        parentThreadId: host.threadId!,
        parentRunId: queuedRun.id,
        workerBotId: worker.id,
        taskId: queuedTask.taskId,
        runId: queuedRun.id,
        computerId: host.computer!.id,
        homeKey: host.computer!.homeKey,
        projectPath: "projects/beta",
        tools: [],
        requestKey: `work:${randomUUID()}`,
      },
    });

    const moved = await assignBotMachine(deps(), actor, {
      botId: parent.id,
      machineId: machineA.id,
    });
    expect(moved.machineId).toBe(machineA.id);
    const held = await prisma.dispatchedWork.findUniqueOrThrow({ where: { id: binding.id } });
    expect(held.computerId).toBe(host.computer!.id);
    expect(held.homeKey).toBe(host.computer!.homeKey);
    await expect(claimDispatchedWork(prisma, queuedRun.id, "worker-owner", 1)).rejects.toThrow(
      WorkScopeError,
    );
    await assignBotMachine(deps(), actor, { botId: parent.id, machineId: null });
    expect((await computerOf(parent.id)).computer!.id).not.toBe(host.computer!.id);
    expect(
      (await prisma.dispatchedWork.findUniqueOrThrow({ where: { id: binding.id } })).computerId,
    ).toBe(host.computer!.id);
    await expect(claimDispatchedWork(prisma, queuedRun.id, "worker-owner", 1)).rejects.toThrow(
      WorkScopeError,
    );
  });

  it("refuses foreign machines, foreign bots, and revoked machines", async () => {
    const bot = await makeBot();
    await expect(
      assignBotMachine(deps(), actor, { botId: bot.id, machineId: foreignMachine.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const other = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: "Other owner",
        email: `other-${randomUUID()}@example.test`,
      },
    });
    const foreignSpace = await bootstrapUserSpace(prisma, other, {
      signupsEnabled: "true",
      signupAllowlist: undefined,
    });
    const foreignBot = await createRepos(prisma).createBot(
      {
        userId: other.id,
        spaceId: foreignSpace.spaceId,
        email: other.email,
        isDeploymentOwner: false,
      },
      {
        name: "Foreign bot",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      },
    );
    await expect(
      assignBotMachine(deps(), actor, { botId: foreignBot.id, machineId: machineA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await prisma.machine.update({
      where: { id: foreignMachine.id },
      data: { status: "revoked" },
    });
    await expect(
      assignBotMachine(deps(), actor, { botId: bot.id, machineId: foreignMachine.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await computerOf(bot.id)).computerSwitching).toBe(false);
  });

  it("refuses a machine revoked mid-relocation and keeps the original assignment", async () => {
    const bot = await makeBot();
    const seeded = await computerOf(bot.id);
    await seedHome(seeded.computer!.homeKey, SEED_FILES);
    await prisma.computer.update({
      where: { id: seeded.computer!.id },
      data: { homeRevision: "rev-seed" },
    });
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const onA = await computerOf(bot.id);
    await materializeMachineSource(onA.computer!.id, "fake-box-race", [
      ...SEED_FILES,
      file("projects/race.txt", "racing"),
    ]);

    const exporter = vi.spyOn(sandbox, "exportWorkspace").mockImplementation(async function* () {
      // The target machine's owner revokes it while the checkpoint is in flight.
      await prisma.machine.update({
        where: { id: machineB.id },
        data: { status: "revoked", credentialHash: null },
      });
      yield file("projects/race.txt", "racing");
    });
    try {
      await expect(
        assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineB.id }),
      ).rejects.toThrow(/no longer paired/i);
    } finally {
      exporter.mockRestore();
    }
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.id).toBe(onA.computer!.id);
    expect(unchanged.computer!.machineId).toBe(machineA.id);
    expect(unchanged.computer!.state).toBe("stopped");
    expect(sandbox.boxes.get("fake-box-race")!.running).toBe(false);
    expect(unchanged.computerSwitching).toBe(false);
  });

  it("refuses an offline stopped machine source instead of moving it", async () => {
    const bot = await makeBot();
    const seeded = await computerOf(bot.id);
    await seedHome(seeded.computer!.homeKey, SEED_FILES);
    await prisma.computer.update({
      where: { id: seeded.computer!.id },
      data: { homeRevision: "rev-seed" },
    });
    await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    const onA = await computerOf(bot.id);
    await prisma.computer.update({
      where: { id: onA.computer!.id },
      data: { providerRef: "fake-box-offline", kind: "machine", state: "stopped" },
    });
    await expect(
      assignBotMachine(deps(), actor, { botId: bot.id, machineId: null }),
    ).rejects.toThrow(/start the bot once more/i);
    const unchanged = await computerOf(bot.id);
    expect(unchanged.computer!.machineId).toBe(machineA.id);
    expect(unchanged.computer!.homeKey).toBe(onA.computer!.homeKey);
    expect(unchanged.computerSwitching).toBe(false);
  });

  it("rejects a move while the switching latch is already held", async () => {
    const bot = await makeBot();
    await prisma.bot.update({ where: { id: bot.id }, data: { computerSwitching: true } });
    await expect(
      assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await computerOf(bot.id)).computerSwitching).toBe(true);
    await prisma.bot.update({ where: { id: bot.id }, data: { computerSwitching: false } });
  });

  it("copies only the team bot's own area plus shared and restores the team computer", async () => {
    const bot = await makeBot("team");
    const host = await computerOf(bot.id);
    expect(host.computer!.scope).toBe("team");
    const teamKey = host.computer!.homeKey;
    await seedHome(teamKey, [
      file(`bots/${bot.id}/work.md`, "mine"),
      file(`bots/${bot.id}/.pi/session.json`, '{"identity":true}'),
      file("bots/peer-bot/private.md", "not mine"),
      file("shared/team-notes.md", "shared"),
    ]);
    await prisma.computer.update({
      where: { id: host.computer!.id },
      data: { homeRevision: "rev-team" },
    });

    const moved = await assignBotMachine(deps(), actor, { botId: bot.id, machineId: machineA.id });
    expect(moved.machineId).toBe(machineA.id);
    const onMachine = await computerOf(bot.id);
    const copied = await homePaths(onMachine.computer!.homeKey);
    expect(copied).toEqual(
      [`bots/${bot.id}/.pi/session.json`, `bots/${bot.id}/work.md`, "shared/team-notes.md"].sort(),
    );
    const teamRow = await prisma.computer.findUniqueOrThrow({ where: { id: host.computer!.id } });
    expect(teamRow.state).toBe("stopped");
    expect(teamRow.homeRevision).toBe("rev-team");
    expect(await homePaths(teamKey)).toContain("bots/peer-bot/private.md");

    const backHome = await assignBotMachine(deps(), actor, { botId: bot.id, machineId: null });
    expect(backHome.machineId).toBeNull();
    const dedicated = await computerOf(bot.id);
    expect(dedicated.computer!.scope).toBe("dedicated");
    expect(dedicated.computer!.kind).toBe("e2b");
    expect(dedicated.computer!.homeKey.startsWith(`${bot.id}-`)).toBe(true);
    const restored = await homePaths(dedicated.computer!.homeKey);
    expect(restored).toEqual(
      [`bots/${bot.id}/.pi/session.json`, `bots/${bot.id}/work.md`, "shared/team-notes.md"].sort(),
    );
    expect(restored).not.toContain("bots/peer-bot/private.md");
  });
});
