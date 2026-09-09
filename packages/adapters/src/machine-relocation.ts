import { randomUUID } from "node:crypto";

import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { MachineAssignmentResult, PrismaClient } from "@rakazo/db";
import { computerHomeKey, computerScopeKey } from "@rakazo/db";
import { hasActiveComputerControl } from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";
import { inspectOfficeModels, type OfficeModelDeps } from "./office-model-preflight.js";

export {
  createLocalOfficeModelResolver,
  type OfficeModelRuntimeResolver,
} from "./office-model-preflight.js";

import { copyAgentHome, teamBotAreaFilter } from "./workspace-transfer.js";

export class MachineRelocationError extends Error {
  constructor(
    public readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
    options?: { message?: string; cause?: unknown },
  ) {
    super(options?.message ?? code, { cause: options?.cause });
    this.name = "MachineRelocationError";
  }
}

/** Run statuses that prove a worker is actually executing (queued work only holds). */
const EXECUTING_RUN_STATUSES = ACTIVE_RUN_STATUSES.filter((status) => status !== "queued");

export interface RelocationComputer {
  id: string;
  scope: string;
  homeKey: string;
  homeRevision: string;
  kind: string;
  providerRef: string | null;
  state: string;
  machineId: string | null;
  controlHolder: string;
  controlLeaseId: string | null;
  controlLeaseExpiresAt: Date | null;
}

export interface MachineRelocationDeps extends OfficeModelDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  /**
   * Computer kind used when the default (unassign) target row is created;
   * derived from the deployment's sandbox configuration, never hardcoded.
   */
  defaultComputerKind?: string;
  /** Mark durable relocation complete in the assignment commit. */
  intentId?: string;
  intentClaimToken?: string;
  assertMoveClaim?: () => void;
}

export interface MachineRelocationInput {
  botId: string;
  /** The bot's current computer, or null when it has none. */
  current: RelocationComputer | null;
  /** Validated target machine id, or null to move back to the default computer. */
  machineId: string | null;
}

function relocationContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

/**
 * Refuses every state that would make a mid-move checkpoint lossy: the bot's
 * own active work, another bot executing on the same computer (temporary
 * dispatched workers), a live foreign execution lease, or an active user
 * control session. Queued dispatched work intentionally does not refuse.
 */
export async function refuseBusyComputer(
  prisma: MachineRelocationDeps["prisma"],
  botId: string,
  current: RelocationComputer,
): Promise<void> {
  const now = new Date();
  const [ownRun, foreignRun, foreignLease, activeWork] = await Promise.all([
    prisma.run.findFirst({
      where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    prisma.run.findFirst({
      where: {
        status: { in: EXECUTING_RUN_STATUSES },
        bot: { computerId: current.id, id: { not: botId } },
      },
      select: { id: true },
    }),
    prisma.computerExecutionLease.findFirst({
      where: { computerId: current.id, botId: { not: botId }, expiresAt: { gt: now } },
      select: { id: true },
    }),
    prisma.dispatchedWork.findFirst({
      where: { computerId: current.id, run: { status: { in: EXECUTING_RUN_STATUSES } } },
      select: { id: true },
    }),
  ]);
  if (ownRun) {
    throw new MachineRelocationError("BAD_REQUEST", {
      message: "Stop the bot's active work before moving it.",
    });
  }
  if (foreignRun || foreignLease || activeWork) {
    throw new MachineRelocationError("BAD_REQUEST", {
      message:
        "Temporary project workers are still using this computer. Wait for their work to finish before moving it.",
    });
  }
  if (hasActiveComputerControl(current)) {
    throw new MachineRelocationError("BAD_REQUEST", { message: "Release the computer first." });
  }
}

/**
 * Verified workspace relocation. Moves the bot's portable home to a distinct
 * target home key through checkpoint -> staged copy -> manifest verify -> one
 * atomic commit (rowlocked machine pairing + target revision + bot CAS), then
 * retires the source gracefully. Any failure keeps the exact original
 * assignment and files.
 */
export async function relocateBotMachine(
  deps: MachineRelocationDeps,
  actor: Actor,
  input: MachineRelocationInput,
): Promise<MachineAssignmentResult> {
  const { prisma, sandbox, home } = deps;
  if (deps.intentId && !deps.intentClaimToken)
    throw new MachineRelocationError("CONFLICT", { message: "Move claim required" });
  const current = input.current;
  const machineId = input.machineId;
  const homeBase = machineId
    ? `machine-${machineId}-${input.botId}`
    : computerHomeKey("dedicated", actor.spaceId, input.botId);
  const targetHomeKey = `${homeBase}-${randomUUID()}`;
  const targetScopeKey = machineId
    ? `machine:${machineId}:${input.botId}`
    : computerScopeKey("dedicated", actor.spaceId, input.botId);

  if (current) await refuseBusyComputer(prisma, input.botId, current);
  const models = await inspectOfficeModels(deps, actor, input.botId, machineId);
  if (models.status !== "available")
    throw new MachineRelocationError("BAD_REQUEST", {
      message: models.error ?? "Pi model authority is unavailable",
    });
  deps.assertMoveClaim?.();

  let frozenState: string | null = null;
  let committed = false;
  let sourceStopped = false;
  let stopUncertain = false;
  try {
    // Freeze the source so peers cannot boot or control it mid-checkpoint. The
    // CAS re-proves state, provider ref, no live execution leases, and no
    // active user control that appeared after the busy checks.
    if (current) {
      if (current.state === "booting" || current.state === "suspending") {
        throw new MachineRelocationError("BAD_REQUEST", {
          message: "The computer is changing state; try moving it again in a moment.",
        });
      }
      const now = new Date();
      const frozen = await prisma.computer.updateMany({
        where: {
          id: current.id,
          state: current.state,
          providerRef: current.providerRef,
          executionLeases: { none: { expiresAt: { gt: now } } },
          OR: [
            { controlHolder: { not: "user" } },
            { controlLeaseId: null },
            { controlLeaseExpiresAt: null },
            { controlLeaseExpiresAt: { lte: now } },
          ],
        },
        data: { state: "suspending" },
      });
      if (frozen.count !== 1) {
        throw new MachineRelocationError("BAD_REQUEST", {
          message: "The computer state changed during relocation; try again.",
        });
      }
      frozenState = current.state;
    }

    if (current?.providerRef && current.state === "running" && sandbox.services) {
      const listed = await sandbox.services.list(
        toComputerRef(current),
        relocationContext(actor, input.botId, "machine.relocate.services"),
      );
      if (
        listed.supported &&
        listed.services.some((service) => !["stopped", "exited", "fatal"].includes(service.status))
      ) {
        throw new MachineRelocationError("BAD_REQUEST", {
          message: "Stop the computer's services before moving it.",
        });
      }
    }
    // Checkpoint the live source into the central home store first. A source
    // that cannot produce a current checkpoint (offline machine, stopped
    // workspace) refuses here so the original assignment stays intact.
    if (current?.providerRef) {
      const localDockerHome = current.kind === "docker" && home instanceof LocalAgentHomeStore;
      if (!localDockerHome && current.state !== "running") {
        throw new MachineRelocationError("BAD_REQUEST", {
          message:
            "Start the bot once more so its workspace can be checkpointed before moving it; otherwise its workspace would be lost.",
        });
      }
      try {
        await checkpointAndRecordComputerWorkspace(
          { prisma, sandbox, home },
          current,
          toComputerRef(current),
          relocationContext(actor, input.botId, "machine.relocate.checkpoint"),
        );
      } catch (error) {
        throw new MachineRelocationError("BAD_REQUEST", {
          message:
            "The bot's workspace could not be checkpointed, so it keeps its current computer; nothing was moved.",
          cause: error,
        });
      }
    }

    // Copy the durable home to the distinct target key and verify the committed
    // copy against a manifest (path, bytes, hash, executable bit).
    let revision: string | null = null;
    if (current) {
      const teamArea = current.scope === "team";
      const copy = await copyAgentHome({
        home,
        fromKey: current.homeKey,
        toKey: targetHomeKey,
        context: relocationContext(actor, input.botId, "machine.relocate.copy"),
        ...(teamArea ? { filter: teamBotAreaFilter(input.botId) } : {}),
      });
      revision = copy.revision;
      if (
        copy.manifest.entries.length === 0 &&
        !teamArea &&
        current.providerRef &&
        current.homeRevision !== "empty"
      ) {
        throw new MachineRelocationError("BAD_REQUEST", {
          message:
            "The verified workspace copy came back empty, so the bot keeps its current computer; nothing was moved.",
        });
      }
    }

    // Stop before switching so a failed stop cannot leave a hidden source running.
    if (current?.providerRef && current.scope !== "team") {
      try {
        await sandbox.stop(
          toComputerRef(current),
          relocationContext(actor, input.botId, "machine.relocate.retire"),
        );
        sourceStopped = true;
      } catch (cause) {
        stopUncertain = true;
        throw new MachineRelocationError("BAD_REQUEST", {
          message: "The source computer could not be stopped; its assignment is unchanged.",
          cause,
        });
      }
    }
    const target = { id: randomUUID() };

    // One atomic commit: the row lock serializes against machine revocation so
    // a move is never accepted onto a machine being revoked, and the bot CAS
    // (still latch-guarded) makes concurrent placement changes lose.
    deps.assertMoveClaim?.();
    await prisma.$transaction(async (tx) => {
      deps.assertMoveClaim?.();
      if (machineId) {
        await tx.$queryRaw`SELECT id FROM "machines" WHERE id = ${machineId} FOR UPDATE`;
        const paired = await tx.machine.findFirst({
          where: { id: machineId, spaceId: actor.spaceId, userId: actor.userId, status: "paired" },
          select: { id: true },
        });
        if (!paired) {
          throw new MachineRelocationError("BAD_REQUEST", {
            message: "The target machine is no longer paired; the bot keeps its current computer.",
          });
        }
      }
      const previous = await tx.computer.findUnique({ where: { scopeKey: targetScopeKey } });
      if (previous) {
        if (previous.spaceId !== actor.spaceId || previous.userId !== actor.userId)
          throw new MachineRelocationError("NOT_FOUND");
        await tx.computer.update({
          where: { id: previous.id },
          data: { scopeKey: `retired:${previous.id}:${randomUUID()}` },
        });
      }
      // A fresh home and row prevent old queued bindings and resumed containers
      // from silently following a later visit to the same machine.
      await tx.computer.create({
        data: {
          id: target.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          scope: "dedicated",
          scopeKey: targetScopeKey,
          homeKey: targetHomeKey,
          kind: machineId ? "machine" : (deps.defaultComputerKind ?? "docker"),
          machineId,
          state: "stopped",
          homeRevision: revision ?? "empty",
        },
      });
      const switched = await tx.bot.updateMany({
        where: {
          id: input.botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          computerId: current?.id ?? null,
          computerSwitching: true,
        },
        data: {
          computerId: target.id,
          ...(deps.intentId ? { computerSwitching: false, officeMoveIntentId: null } : {}),
        },
      });
      if (switched.count !== 1) throw new MachineRelocationError("CONFLICT");
      if (deps.intentId) {
        const completed = await tx.officeMoveIntent.updateMany({
          where: { id: deps.intentId, status: "processing", claimToken: deps.intentClaimToken },
          data: { status: "completed", resultComputerId: target.id },
        });
        if (completed.count !== 1)
          throw new MachineRelocationError("CONFLICT", { message: "Move claim lost" });
        deps.assertMoveClaim?.();
      }
    });
    committed = true;

    // Graceful retire: the source keeps its row (queued dispatched workers and
    // machine-bound refs stay resolvable) but is stopped and released. Shared
    // team computers are only restored, never stopped or lease-cleared.
    if (current) {
      const dedicated = current.scope !== "team";
      if (dedicated) {
        if (current.providerRef) {
          await prisma.computerExecutionLease.deleteMany({ where: { computerId: current.id } });
        }
        await prisma.computer.updateMany({
          where: { id: current.id, state: "suspending" },
          data: {
            state: "stopped",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
          },
        });
      } else if (frozenState) {
        await prisma.computer.updateMany({
          where: { id: current.id, state: "suspending" },
          data: { state: frozenState },
        });
      }
    }
    return { botId: input.botId, machineId, computerId: target.id };
  } catch (error) {
    if (!committed && frozenState !== null && current) {
      await prisma.computer.updateMany({
        where: { id: current.id, state: "suspending", providerRef: current.providerRef },
        data: { state: sourceStopped ? "stopped" : stopUncertain ? "failed" : frozenState },
      });
    }
    throw error;
  }
}
