import { EventEmitter } from "node:events";
import { parseBackgroundJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { assignBotMachine } from "./machine-assignment.js";
import {
  enqueueApprovedOfficeMove,
  handleOfficeMoveIntent,
  type OfficeMoveIntentDeps,
  reconcileOfficeMoveIntents,
} from "./office-move-intents.js";

vi.mock("./machine-assignment.js", () => ({ assignBotMachine: vi.fn() }));
const actor = { spaceId: "space", userId: "owner" } as Actor;
const input = {
  botId: "bot",
  runId: "run",
  approvedEffectId: "receipt",
  currentComputerId: "source",
  machineId: "target",
};
function fixture() {
  const intent = {
    id: "intent",
    ...actor,
    ...input,
    effectKey: "stable-key",
    status: "pending",
    nextAttemptAt: new Date(0),
    resultComputerId: null,
  };
  const computer = { id: "source", controlHolder: "none" };
  const prisma = {
    externalEffect: {
      findFirst: vi.fn().mockResolvedValue({
        idempotencyKey: "stable-key",
        request: { action: "move", machineId: "target" },
      }),
    },
    officeMoveIntent: {
      upsert: vi.fn().mockResolvedValue(intent),
      findUnique: vi.fn().mockImplementation(async () => intent),
      findMany: vi.fn().mockResolvedValue([{ id: "intent" }]),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(intent, data)),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(intent, data);
        return { count: 1 };
      }),
    },
    run: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) => (where.id ? { status: "completed" } : null)),
    },
    bot: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ computerId: "source", computer, computerSwitching: false }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    machine: { findFirst: vi.fn().mockResolvedValue({ id: "target" }) },
    computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
    dispatchedWork: { findFirst: vi.fn().mockResolvedValue(null) },
    computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ acquired: true, released: true }] }),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(assignBotMachine)
    .mockReset()
    .mockResolvedValue({ botId: "bot", machineId: "target", computerId: "destination" });
  vi.mocked(assignBotMachine).mockImplementation(async () => {
    intent.status = "completed";
    return { botId: "bot", machineId: "target", computerId: "destination" };
  });
  return {
    prisma,
    jobs,
    intent,
    client,
    pool,
    deps: { prisma, jobs, pool } as unknown as OfficeMoveIntentDeps,
  };
}
describe("approved durable office moves", () => {
  it("binds executing approval receipt to exact owner/run/tool and stable idempotency key", async () => {
    const { deps, prisma } = fixture();
    const first = await enqueueApprovedOfficeMove(deps, actor, input);
    expect(await enqueueApprovedOfficeMove(deps, actor, input)).toEqual(first);
    expect(prisma.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "receipt",
          runId: "run",
          spaceId: "space",
          status: "executing",
          kind: "manage_office",
          run: { botId: "bot", userId: "owner" },
        },
      }),
    );
    expect(prisma.officeMoveIntent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { effectKey: "stable-key" }, update: {} }),
    );
    expect(assignBotMachine).not.toHaveBeenCalled();
  });
  it("rejects denied/unclaimed/mismatched receipts before persistence", async () => {
    const { deps, prisma } = fixture();
    prisma.externalEffect.findFirst.mockResolvedValue(null);
    await expect(enqueueApprovedOfficeMove(deps, actor, input)).rejects.toThrow("receipt required");
    prisma.externalEffect.findFirst.mockResolvedValue({
      idempotencyKey: "key",
      request: { action: "move", machineId: "other" },
    });
    await expect(enqueueApprovedOfficeMove(deps, actor, input)).rejects.toThrow("mismatch");
    expect(prisma.officeMoveIntent.upsert).not.toHaveBeenCalled();
  });
  it("waits for its own origin run to terminate without moving or touching queued work", async () => {
    const { deps, prisma, intent } = fixture();
    prisma.run.findFirst.mockResolvedValue({ status: "running" });
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(intent.status).toBe("pending");
    expect(intent.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(assignBotMachine).not.toHaveBeenCalled();
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
  });
  it.each(["foreignRun", "lease", "dispatched"])("waits for Fabric workers: %s", async (busy) => {
    const { deps, prisma, intent } = fixture();
    if (busy === "foreignRun")
      prisma.run.findFirst.mockImplementation(async ({ where }) =>
        where.id ? { status: "completed" } : where.bot ? { id: "foreign" } : null,
      );
    if (busy === "lease")
      prisma.computerExecutionLease.findFirst.mockResolvedValue({ id: "lease" });
    if (busy === "dispatched") prisma.dispatchedWork.findFirst.mockResolvedValue({ id: "work" });
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(intent.status).toBe("pending");
    expect(assignBotMachine).not.toHaveBeenCalled();
  });
  it.each(["target", "source", "owner"])("rejects revoked or changed %s", async (changed) => {
    const { deps, prisma, intent } = fixture();
    if (changed === "target") prisma.machine.findFirst.mockResolvedValue(null);
    if (changed === "source") prisma.bot.findFirst.mockResolvedValue({ computerId: "different" });
    if (changed === "owner") prisma.bot.findFirst.mockResolvedValue(null);
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(intent.status).toBe("failed");
    expect(assignBotMachine).not.toHaveBeenCalled();
  });
  it("consumes durable pending intent after worker restart even if effect completion was lost", async () => {
    const { deps, jobs, intent, prisma } = fixture();
    await reconcileOfficeMoveIntents(deps);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      name: "office.move",
      payload: { intentId: "intent" },
      replaceKey: "office.move:intent",
    });
    const restarted = { ...deps };
    await handleOfficeMoveIntent(restarted, { intentId: "intent" });
    expect(assignBotMachine).toHaveBeenCalledWith(
      expect.objectContaining({ ...restarted, assertMoveClaim: expect.any(Function) }),
      actor,
      {
        botId: "bot",
        machineId: "target",
        expectedComputerId: "source",
        intentId: "intent",
        intentClaimToken: expect.any(String),
      },
    );
    expect(intent.status).toBe("completed");
    await handleOfficeMoveIntent(restarted, { intentId: "intent" });
    expect(assignBotMachine).toHaveBeenCalledTimes(1);
    expect(prisma.externalEffect.findFirst).not.toHaveBeenCalled();
  });
  it("holds interrupted in-flight transfer safely instead of replaying an uncertain source stop", async () => {
    const { deps, intent, prisma } = fixture();
    intent.status = "processing";
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(intent.status).toBe("failed");
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(assignBotMachine).not.toHaveBeenCalled();
  });
  it("does not overlap another durable consumer", async () => {
    const { deps, prisma, client } = fixture();
    client.query.mockResolvedValue({ rows: [{ acquired: false, released: false }] });
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(prisma.officeMoveIntent.findUnique).not.toHaveBeenCalled();
  });
  it("revokes a lost session fence and drains revocation before returning the connection", async () => {
    const { deps, client, prisma, intent } = fixture();
    let resolveRevoke!: () => void;
    const revoked = new Promise<void>((resolve) => {
      resolveRevoke = resolve;
    });
    prisma.officeMoveIntent.updateMany.mockImplementationOnce(async ({ data }) => {
      await revoked;
      Object.assign(intent, data);
      return { count: 1 };
    });
    vi.mocked(assignBotMachine).mockImplementation(async (assignmentDeps) => {
      intent.status = "processing";
      client.emit("error", new Error("connection lost"));
      expect(() => assignmentDeps.assertMoveClaim?.()).toThrow("lock lost");
      throw new Error("claim revoked");
    });
    const running = handleOfficeMoveIntent(deps, { intentId: "intent" });
    await vi.waitFor(() => expect(prisma.officeMoveIntent.updateMany).toHaveBeenCalledTimes(2));
    expect(client.release).not.toHaveBeenCalled();
    resolveRevoke();
    await running;
    expect(client.release).toHaveBeenCalledWith(true);
    expect(intent.status).toBe("failed");
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
  });
  it("destroys connections after uncertain unlock rather than leaking a session lock", async () => {
    const { deps, client } = fixture();
    client.query
      .mockResolvedValueOnce({ rows: [{ acquired: true, released: false }] })
      .mockRejectedValueOnce(new Error("disconnect"));
    await handleOfficeMoveIntent(deps, { intentId: "intent" });
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it("validates job payloads at the transport boundary", () => {
    expect(parseBackgroundJob("office.move", { intentId: "intent" }).name).toBe("office.move");
    for (const payload of [{}, { intentId: "" }, { intentId: "intent", machineId: "injected" }])
      expect(() => parseBackgroundJob("office.move", payload)).toThrow();
  });
});
