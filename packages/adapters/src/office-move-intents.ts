import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Pool } from "pg";
import { assignBotMachine, type MachineAssignDeps } from "./machine-assignment.js";
import { refuseBusyComputer } from "./machine-relocation.js";

export interface OfficeMoveIntentDeps extends MachineAssignDeps {
  jobs: JobPublisher;
  pool: Pick<Pool, "connect">;
}
const RETRY_MS = 30_000;

/** Dedicated one-connection pool serializes copies without starving ordinary queries. */
export function createOfficeMovePool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  pool.on("error", () => getLogger().error("Office move lock pool connection lost"));
  return pool;
}

/** The effect row ID comes only from the explicit human gate; its key supplies idempotence. */
export async function enqueueApprovedOfficeMove(
  deps: { prisma: PrismaClient },
  actor: Pick<Actor, "spaceId" | "userId">,
  input: {
    botId: string;
    runId: string;
    approvedEffectId: string;
    currentComputerId: string | null;
    machineId: string | null;
  },
) {
  if (!input.approvedEffectId.trim()) throw new Error("Explicit approval receipt required");
  const receipt = await deps.prisma.externalEffect.findFirst({
    where: {
      id: input.approvedEffectId,
      runId: input.runId,
      spaceId: actor.spaceId,
      status: "executing",
      kind: "manage_office",
      run: { botId: input.botId, userId: actor.userId },
    },
    select: { idempotencyKey: true, request: true },
  });
  if (!receipt) throw new Error("Explicit approval receipt required");
  const request = receipt.request as Record<string, unknown> | null;
  if (
    !request ||
    Array.isArray(request) ||
    request.action !== "move" ||
    request.machineId !== input.machineId ||
    Object.keys(request).length !== 2
  )
    throw new Error("Approval receipt mismatch");
  const { approvedEffectId: _receiptId, ...snapshot } = input;
  const intent = await deps.prisma.officeMoveIntent.upsert({
    where: { effectKey: receipt.idempotencyKey },
    update: {},
    create: {
      ...snapshot,
      effectKey: receipt.idempotencyKey,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  if (
    intent.spaceId !== actor.spaceId ||
    intent.userId !== actor.userId ||
    intent.botId !== input.botId ||
    intent.runId !== input.runId ||
    intent.machineId !== input.machineId
  )
    throw new Error("Approval receipt mismatch");
  return { id: intent.id, status: intent.status };
}

/** A session lock has no interactive-transaction deadline during external copying.
 * The durable claim token and bot latch remain the final fences if this connection dies.
 */
export async function handleOfficeMoveIntent(
  deps: OfficeMoveIntentDeps,
  payload: { intentId: string },
): Promise<void> {
  const client = await deps.pool.connect();
  const key = `office.move:${payload.intentId}`;
  let acquired = false;
  let lost = false;
  let claimToken: string | undefined;
  let revocation: Promise<unknown> | undefined;
  const onError = () => {
    lost = true;
    if (claimToken && !revocation)
      revocation = deps.prisma.officeMoveIntent
        .updateMany({
          where: { id: payload.intentId, status: "processing", claimToken },
          data: { status: "failed", error: "Move lock lost; source requires inspection." },
        })
        .catch(() => undefined); // Synchronous commit guard also fails closed if the database is unavailable.
  };
  client.on("error", onError);
  client.on("end", onError);
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired || lost) return;
    const intent = await deps.prisma.officeMoveIntent.findUnique({
      where: { id: payload.intentId },
    });
    if (!intent || !["pending", "processing"].includes(intent.status)) return;
    const fail = async (error: string) => {
      await deps.prisma.officeMoveIntent.updateMany({
        where: { id: intent.id, status: intent.status, claimToken: intent.claimToken },
        data: { status: "failed", error },
      });
    };
    if (intent.status === "processing") {
      // The previous worker died after claiming the placement latch. Do not replay an
      // uncertain stop/checkpoint or silently start a stale root. Preserve files.
      // A lost lock does not prove the old external copy stopped. Never release
      // its latch here: quarantine the intent, and fence its eventual commit.
      // The original worker releases its own latch only after its work settles.
      await fail("Move interrupted; source remains held for inspection before retrying.");
      return;
    }
    if (intent.nextAttemptAt > new Date()) return;
    const run = await deps.prisma.run.findFirst({
      where: {
        id: intent.runId,
        botId: intent.botId,
        spaceId: intent.spaceId,
        userId: intent.userId,
      },
      select: { status: true },
    });
    if (!run) {
      await fail("Origin run unavailable");
      return;
    }
    const wait = async () => {
      await deps.prisma.officeMoveIntent.updateMany({
        where: { id: intent.id, status: "pending" },
        data: { nextAttemptAt: new Date(Date.now() + RETRY_MS) },
      });
    };
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      await wait();
      return;
    }
    const actor = { spaceId: intent.spaceId, userId: intent.userId } as Actor;
    const bot = await deps.prisma.bot.findFirst({
      where: { id: intent.botId, ...actor },
      include: { computer: true },
    });
    if (!bot || bot.computerId !== intent.currentComputerId) {
      await fail("Source assignment changed");
      return;
    }
    if (
      intent.machineId &&
      !(await deps.prisma.machine.findFirst({
        where: { id: intent.machineId, ...actor, status: "paired" },
        select: { id: true },
      }))
    ) {
      await fail("Target machine is no longer paired");
      return;
    }
    if (bot.computerSwitching) {
      await wait();
      return;
    }
    if (bot.computer) {
      try {
        await refuseBusyComputer(deps.prisma, intent.botId, bot.computer);
      } catch {
        await wait();
        return;
      }
    }
    if (lost) throw new Error("Office move lock connection lost");
    claimToken = randomUUID();
    try {
      await assignBotMachine(
        {
          ...deps,
          assertMoveClaim: () => {
            if (lost) throw new Error("Office move lock lost");
          },
        },
        actor,
        {
          botId: intent.botId,
          machineId: intent.machineId,
          expectedComputerId: intent.currentComputerId,
          intentId: intent.id,
          intentClaimToken: claimToken,
        },
      );
    } catch (error) {
      getLogger().error("Office relocation failed", error);
      // Do not replace a commit receipt if only source-retirement bookkeeping failed.
      await deps.prisma.officeMoveIntent.updateMany({
        where: { id: intent.id, status: "processing", claimToken },
        data: { status: "failed", error: "Relocation failed; inspect the source before retrying." },
      });
    }
  } catch (error) {
    // Even acquisition can have an uncertain outcome if its response is lost.
    lost = true;
    throw error;
  } finally {
    if (acquired && !lost) {
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [key],
        );
        if (!result.rows[0]?.released) lost = true;
      } catch {
        lost = true;
      }
    }
    await revocation;
    client.removeListener("error", onError);
    client.removeListener("end", onError);
    client.release(lost);
  }
}

/** Rebuild queue delivery from durable intent; no timers or detached promises here. */
export async function reconcileOfficeMoveIntents(
  deps: Pick<OfficeMoveIntentDeps, "prisma" | "jobs">,
): Promise<void> {
  const intents = await deps.prisma.officeMoveIntent.findMany({
    where: { status: { in: ["pending", "processing"] }, nextAttemptAt: { lte: new Date() } },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const intent of intents)
    await deps.jobs.enqueue({
      name: "office.move",
      payload: { intentId: intent.id },
      replaceKey: `office.move:${intent.id}`,
    });
}
