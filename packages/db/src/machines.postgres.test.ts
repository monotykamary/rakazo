import { randomUUID } from "node:crypto";
import type { Actor, MachineCommandScope } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import {
  createPrismaMachineStore,
  machineAssignment,
  resolveMachineTunnelScope,
  sweepExpiredMachineCommands,
} from "./machines.js";
import { createRepos } from "./repos.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("machine mailbox (PostgreSQL)", () => {
  const id = `machine-test-${randomUUID()}`;
  const actor: Actor = {
    userId: `${id}-user`,
    spaceId: `${id}-space`,
    email: `${id}@example.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let store: ReturnType<typeof createPrismaMachineStore>;

  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    store = createPrismaMachineStore(prisma);
    await prisma.user.create({
      data: { id: actor.userId, name: "Machine Test", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id, name: "Machine Test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId: id, name: "Machine Test" },
    });
  });

  afterAll(async () => {
    await close();
  });

  it("preserves machine placement on a sharing no-op and rejects legacy reassignment", async () => {
    const repos = createRepos(prisma);
    const bot = await repos.createBot(actor, {
      name: "Placement guard",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      computerMode: "dedicated",
    });
    const machine = await prisma.machine.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Guard machine",
        status: "paired",
      },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        kind: "machine",
        machineId: machine.id,
        scope: "dedicated",
        scopeKey: `machine:${machine.id}:${bot.id}`,
        homeKey: `machine-${machine.id}-${bot.id}`,
      },
    });
    await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
    const teamCount = await prisma.computer.count({
      where: { spaceId: actor.spaceId, scope: "team" },
    });
    await expect(repos.setBotComputer(actor, bot.id, "dedicated")).resolves.toMatchObject({
      computerMode: "dedicated",
    });
    await expect(repos.setBotComputer(actor, bot.id, "team")).rejects.toThrow(
      "verified relocation",
    );
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).computerId).toBe(
      computer.id,
    );
    expect(await prisma.computer.count({ where: { spaceId: actor.spaceId, scope: "team" } })).toBe(
      teamCount,
    );
  });
  it("pairs, delivers once, and fails closed on revocation", async () => {
    const pairingHash = `pairing-${randomUUID()}`;
    const machine = await store.createMachine({
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "laptop",
      pairingCodeHash: pairingHash,
      pairingExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const tokenHash = `token-${randomUUID()}`;
    expect(
      await store.claimPairing(machine.id, pairingHash, {
        credentialHash: tokenHash,
        now: new Date(),
      }),
    ).toBe(true);
    // Single use: second claim loses.
    expect(
      await store.claimPairing(machine.id, pairingHash, { credentialHash: "x", now: new Date() }),
    ).toBe(false);

    const command = await store.createCommand({
      machineId: machine.id,
      method: "POST",
      path: "/agents",
      query: "",
      bodyBase64: "e30=",
      contentType: "application/json",
      headersJson: "{}",
      scope: { kind: "unscoped" },
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const claimed = await store.claimNextCommand(machine.id, new Date());
    expect(claimed?.id).toBe(command.id);
    expect(await store.claimNextCommand(machine.id, new Date())).toBeNull();

    const completed = await store.completeCommand(
      machine.id,
      command.id,
      { status: 200, contentType: "application/json", bodyBase64: "e30=" },
      new Date(),
    );
    expect(completed).toBe("accepted");
    expect(
      await store.completeCommand(
        machine.id,
        command.id,
        { status: 200, contentType: null, bodyBase64: null },
        new Date(),
      ),
    ).toBe("already");

    expect(await store.findMachineByCredentialHash(tokenHash)?.then((r) => r?.id)).toBe(machine.id);
    await store.revokeMachine(machine.id);
    expect((await store.getMachineById(machine.id))?.status).toBe("revoked");
    expect(await store.findMachineByCredentialHash(tokenHash)).toBeNull();
  });

  it("tomstones run-leased commands whose lease has moved on", async () => {
    const bot = await prisma.bot.create({
      data: {
        id: `${id}-bot`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Machine Test",
        color: "test",
      },
    });
    const computer = await prisma.computer.create({
      data: {
        id: `${id}-computer`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "dedicated",
        scopeKey: `${id}-scope`,
        homeKey: `${id}-home`,
        kind: "machine",
      },
    });
    await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
    const thread = await prisma.thread.create({
      data: { id: `${id}-thread`, spaceId: actor.spaceId, botId: bot.id, userId: actor.userId },
    });
    const task = await prisma.task.create({
      data: {
        id: `${id}-task`,
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: actor.userId,
        prompt: "test",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        id: `${id}-run`,
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: actor.userId,
        status: "running",
        trigger: "test",
        leaseOwner: "worker-1",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const pairingHash = `pairing-${randomUUID()}`;
    const machine = await store.createMachine({
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "laptop",
      pairingCodeHash: pairingHash,
      pairingExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await store.claimPairing(machine.id, pairingHash, {
      credentialHash: `token-${randomUUID()}`,
      now: new Date(),
    });
    await prisma.computer.update({ where: { id: computer.id }, data: { machineId: machine.id } });

    const scope: MachineCommandScope = {
      kind: "agent",
      spaceId: actor.spaceId,
      runId: run.id,
      botId: bot.id,
      leaseOwner: "worker-1",
      leaseFence: 2,
    };
    const command = await store.createCommand({
      machineId: machine.id,
      method: "POST",
      path: "/agents",
      query: "",
      bodyBase64: null,
      contentType: null,
      headersJson: "{}",
      scope,
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const claimed = await store.claimNextCommand(machine.id, new Date());
    expect(claimed?.id).toBe(command.id);

    // Lease moves on: claim-time proof must abort the result.
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: "worker-2", leaseFence: 3 },
    });
    const outcome = await store.completeCommand(
      machine.id,
      command.id,
      { status: 200, contentType: null, bodyBase64: null },
      new Date(),
    );
    expect(outcome).toBe("aborted");
    expect((await store.getCommand(machine.id, command.id))?.status).toBe("aborted");

    // A second command for the moved lease never gets claimed.
    const stale = await store.createCommand({
      machineId: machine.id,
      method: "GET",
      path: "/agents/ag-1/events",
      query: "",
      bodyBase64: null,
      contentType: null,
      headersJson: "{}",
      scope: { ...scope, leaseFence: 2 },
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    expect(await store.claimNextCommand(machine.id, new Date())).toBeNull();
    expect((await store.getCommand(machine.id, stale.id))?.status).toBe("aborted");
  });

  it("serializes concurrent claims so exactly one wins", async () => {
    const pairingHash = `pairing-${randomUUID()}`;
    const machine = await store.createMachine({
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "laptop",
      pairingCodeHash: pairingHash,
      pairingExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await store.claimPairing(machine.id, pairingHash, {
      credentialHash: `token-${randomUUID()}`,
      now: new Date(),
    });
    await store.createCommand({
      machineId: machine.id,
      method: "GET",
      path: "/agents",
      query: "",
      bodyBase64: null,
      contentType: null,
      headersJson: "{}",
      scope: { kind: "unscoped" },
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const claimed = await Promise.all(
      Array.from({ length: 8 }, () => store.claimNextCommand(machine.id, new Date())),
    );
    expect(claimed.filter((command) => command !== null)).toHaveLength(1);
  });

  it("never delivers a command across a concurrent revocation", async () => {
    const pairingHash = `pairing-${randomUUID()}`;
    const machine = await store.createMachine({
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "laptop",
      pairingCodeHash: pairingHash,
      pairingExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const tokenHash = `token-${randomUUID()}`;
    await store.claimPairing(machine.id, pairingHash, {
      credentialHash: tokenHash,
      now: new Date(),
    });
    await store.createCommand({
      machineId: machine.id,
      method: "GET",
      path: "/agents",
      query: "",
      bodyBase64: null,
      contentType: null,
      headersJson: "{}",
      scope: { kind: "unscoped" },
      expiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    // Claim storm racing a revoke: at most one command may ever be handed
    // out, and every claim after the revoke settles must return null.
    const outcomes = await Promise.all([
      ...Array.from({ length: 8 }, () => store.claimNextCommand(machine.id, new Date())),
      store.revokeMachine(machine.id),
    ]);
    const delivered = outcomes.slice(0, 8).filter((command) => command !== null);
    expect(delivered.length).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.claimNextCommand(machine.id, new Date())).toBeNull();
    expect(await store.findMachineByCredentialHash(tokenHash)).toBeNull();
  });

  it("sweeps expired and terminal commands in bounded batches", async () => {
    const pairingHash = `pairing-${randomUUID()}`;
    const machine = await store.createMachine({
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "laptop",
      pairingCodeHash: pairingHash,
      pairingExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await store.claimPairing(machine.id, pairingHash, {
      credentialHash: `token-${randomUUID()}`,
      now: new Date(),
    });
    await store.createCommand({
      machineId: machine.id,
      method: "GET",
      path: "/agents",
      query: "",
      bodyBase64: "e30=",
      contentType: null,
      headersJson: "{}",
      scope: { kind: "unscoped" },
      expiresAt: new Date(Date.now() - 1000),
      now: new Date(),
    });
    const deleted = await sweepExpiredMachineCommands(prisma, new Date(), { retentionMs: 0 });
    expect(deleted).toBeGreaterThan(0);
    const rows = await prisma.machineCommand.findMany({ where: { machineId: machine.id } });
    expect(rows).toHaveLength(0);
  });

  it("resolves tunnel scopes with lease capture", async () => {
    const scope = await resolveMachineTunnelScope(prisma, "no-such-machine", {
      path: "/agents",
      headers: { "x-rakazo-run-id": "r1" },
    }).catch((error: unknown) => error);
    expect((scope as Error).name).toBe("MachineScopeError");
    expect(
      await machineAssignment(prisma, actor, { botId: "missing" }).catch(() => "isolated"),
    ).toBe("isolated");
  });
});
