import type {
  MachineCommandRecord,
  MachineCommandResult,
  MachineCommandScope,
  MachineRecord,
  MachineStore,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

function toMachineRecord(row: {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  status: string;
  pairingCodeHash: string | null;
  pairingExpiresAt: Date | null;
  credentialHash: string | null;
  lastSeenAt: Date | null;
  version: string | null;
  createdAt: Date;
}): MachineRecord {
  return {
    id: row.id,
    spaceId: row.spaceId,
    userId: row.userId,
    name: row.name,
    status: row.status as MachineRecord["status"],
    pairingCodeHash: row.pairingCodeHash,
    pairingExpiresAt: row.pairingExpiresAt,
    credentialHash: row.credentialHash,
    lastSeenAt: row.lastSeenAt,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function toCommandRecord(row: {
  id: string;
  machineId: string;
  method: string;
  path: string;
  query: string;
  bodyBase64: string | null;
  contentType: string | null;
  headersJson: string;
  scopeKind: string;
  scopeSpaceId: string | null;
  scopeRunId: string | null;
  scopeBotId: string | null;
  scopeComputerId: string | null;
  scopeLeaseOwner: string | null;
  scopeLeaseFence: number | null;
  status: string;
  responseStatus: number | null;
  responseContentType: string | null;
  responseBodyBase64: string | null;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
}): MachineCommandRecord {
  return {
    id: row.id,
    machineId: row.machineId,
    method: row.method,
    path: row.path,
    query: row.query,
    bodyBase64: row.bodyBase64,
    contentType: row.contentType,
    headersJson: row.headersJson,
    scopeKind: row.scopeKind as MachineCommandScope["kind"],
    scopeSpaceId: row.scopeSpaceId,
    scopeRunId: row.scopeRunId,
    scopeBotId: row.scopeBotId,
    scopeComputerId: row.scopeComputerId,
    scopeLeaseOwner: row.scopeLeaseOwner,
    scopeLeaseFence: row.scopeLeaseFence,
    status: row.status as MachineCommandRecord["status"],
    responseStatus: row.responseStatus,
    responseContentType: row.responseContentType,
    responseBodyBase64: row.responseBodyBase64,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
  };
}

const scopeSelect = {
  path: true,
  headersJson: true,
  createdAt: true,
  scopeKind: true,
  scopeSpaceId: true,
  scopeRunId: true,
  scopeBotId: true,
  scopeComputerId: true,
  scopeLeaseOwner: true,
  scopeLeaseFence: true,
} satisfies Prisma.MachineCommandSelect;

const commandColumns = {
  id: true,
  machineId: true,
  method: true,
  query: true,
  bodyBase64: true,
  contentType: true,
  ...scopeSelect,
  status: true,
  responseStatus: true,
  responseContentType: true,
  responseBodyBase64: true,
  createdAt: true,
  expiresAt: true,
  claimedAt: true,
} satisfies Prisma.MachineCommandSelect;

interface CommandScopeRow {
  path: string;
  headersJson: string;
  createdAt: Date;
  scopeKind: string;
  scopeSpaceId: string | null;
  scopeRunId: string | null;
  scopeBotId: string | null;
  scopeComputerId: string | null;
  scopeLeaseOwner: string | null;
  scopeLeaseFence: number | null;
}

function runLeaseMatches(command: CommandScopeRow): {
  leaseOwner: string;
  leaseFence: number;
} | null {
  if (!command.scopeLeaseOwner || command.scopeLeaseFence == null) return null;
  return { leaseOwner: command.scopeLeaseOwner, leaseFence: command.scopeLeaseFence };
}

/**
 * Scope proof at claim time (and again at result acceptance). A command only
 * leaves the mailbox — and only has its result stored — while its captured
 * scope still resolves: the machine credential is paired, the run lease has
 * not moved on (owner/fence/expiry match the captured values, not fresh ones),
 * and the owning bot is neither archived nor deleted. Anything else is
 * tombstoned so stale work can never execute or land.
 */
async function scopeStillResolves(
  tx: Prisma.TransactionClient,
  machineId: string,
  now: Date,
  command: CommandScopeRow,
): Promise<boolean> {
  if (command.scopeKind === "computer") {
    if (!command.scopeComputerId || !command.scopeSpaceId) return false;
    const computer = await tx.computer.findFirst({
      where: {
        // Machine-local refs arrive as providerRef; backend rows as id.
        OR: [{ id: command.scopeComputerId }, { providerRef: command.scopeComputerId }],
        spaceId: command.scopeSpaceId,
        machineId,
      },
      select: { id: true, homeKey: true, providerRef: true, state: true, updatedAt: true },
    });
    if (!computer) return false;
    let headers: Record<string, string>;
    try {
      headers = JSON.parse(command.headersJson);
    } catch {
      return false;
    }
    if (
      !headers ||
      headers["x-rakazo-bot-id"] !== computer.homeKey ||
      headers["x-rakazo-space-id"] !== command.scopeSpaceId
    )
      return false;
    const ref = /^\/computers\/([A-Za-z0-9._~-]+)(?:\/|$)/.exec(command.path)?.[1];
    const bound =
      ref && (ref === computer.id || computer.providerRef === `machine:${machineId}:${ref}`);
    // Workspace restore and rollback happen before activation saves providerRef.
    // Only the current boot can use this provisional ref; a request queued before
    // a newer boot claim is stale. The supervisor also enforces home/space labels.
    const provisioning = computer.state === "booting" && computer.updatedAt <= command.createdAt;
    if (!bound && !provisioning) return false;
    const lease = runLeaseMatches(command);
    if (command.scopeRunId && !lease) return false; // malformed partial scope
    if (!lease) return true; // authorized lease-less maintenance
    if (!command.scopeRunId) return false;
    const run = await tx.run.findFirst({
      where: {
        id: command.scopeRunId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        leaseOwner: lease.leaseOwner,
        leaseFence: lease.leaseFence,
        leaseExpiresAt: { gt: now },
        bot: { computerId: computer.id, archivedAt: null },
      },
      select: { id: true },
    });
    return run !== null;
  }
  if (command.scopeKind === "agent") {
    if (!command.scopeRunId || !command.scopeSpaceId || !command.scopeBotId) return false;
    const lease = runLeaseMatches(command);
    if (!lease) return false; // run-bound commands always carry a lease
    const run = await tx.run.findFirst({
      where: {
        id: command.scopeRunId,
        spaceId: command.scopeSpaceId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        leaseOwner: lease.leaseOwner,
        leaseFence: lease.leaseFence,
        leaseExpiresAt: { gt: now },
        botId: command.scopeBotId,
        bot: { computer: { machineId }, archivedAt: null },
      },
      select: { id: true },
    });
    return run !== null;
  }
  return command.scopeKind === "unscoped";
}

export function createPrismaMachineStore(prisma: PrismaClient): MachineStore {
  return {
    async createMachine(input) {
      const row = await prisma.machine.create({
        data: {
          spaceId: input.spaceId,
          userId: input.userId,
          name: input.name,
          status: "pending",
          pairingCodeHash: input.pairingCodeHash,
          pairingExpiresAt: input.pairingExpiresAt,
        },
      });
      return toMachineRecord(row);
    },
    async listMachines(spaceId, userId) {
      const rows = await prisma.machine.findMany({
        where: { spaceId, userId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return rows.map(toMachineRecord);
    },
    async getMachine(spaceId, userId, machineId) {
      const row = await prisma.machine.findFirst({ where: { id: machineId, spaceId, userId } });
      return row ? toMachineRecord(row) : null;
    },
    async getMachineById(machineId) {
      const row = await prisma.machine.findUnique({ where: { id: machineId } });
      return row ? toMachineRecord(row) : null;
    },
    async updateMachine(machineId, patch) {
      await prisma.machine.updateMany({ where: { id: machineId }, data: patch });
    },
    async deleteMachine(machineId) {
      await prisma.machine.deleteMany({ where: { id: machineId } });
    },
    async findMachineByPairingHash(hash) {
      const row = await prisma.machine.findFirst({
        where: { pairingCodeHash: hash },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return row ? toMachineRecord(row) : null;
    },
    async findMachineByCredentialHash(hash) {
      const row = await prisma.machine.findFirst({
        where: { credentialHash: hash },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return row ? toMachineRecord(row) : null;
    },
    async claimPairing(machineId, pairingCodeHash, patch) {
      const updated = await prisma.machine.updateMany({
        where: { id: machineId, status: "pending", pairingCodeHash },
        data: {
          status: "paired",
          credentialHash: patch.credentialHash,
          pairingCodeHash: null,
          pairingExpiresAt: null,
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.version ? { version: patch.version } : {}),
          lastSeenAt: patch.now,
        },
      });
      return updated.count === 1;
    },
    async revokeMachine(machineId) {
      await prisma.$transaction([
        prisma.machine.updateMany({
          where: { id: machineId, status: { not: "revoked" } },
          data: {
            status: "revoked",
            credentialHash: null,
            pairingCodeHash: null,
            pairingExpiresAt: null,
          },
        }),
        prisma.machineCommand.updateMany({
          where: { machineId, status: { in: ["pending", "claimed"] } },
          data: { status: "aborted" },
        }),
      ]);
    },
    async createCommand(input) {
      const row = await prisma.machineCommand.create({
        data: {
          machineId: input.machineId,
          method: input.method,
          path: input.path,
          query: input.query,
          bodyBase64: input.bodyBase64,
          contentType: input.contentType,
          headersJson: input.headersJson,
          scopeKind: input.scope.kind,
          scopeSpaceId: input.scope.kind === "unscoped" ? null : input.scope.spaceId,
          scopeRunId:
            input.scope.kind === "agent"
              ? input.scope.runId
              : input.scope.kind === "computer"
                ? (input.scope.runId ?? null)
                : null,
          scopeBotId: input.scope.kind === "agent" ? input.scope.botId : null,
          scopeComputerId: input.scope.kind === "computer" ? input.scope.computerId : null,
          scopeLeaseOwner:
            input.scope.kind === "unscoped" ? null : (input.scope.leaseOwner ?? null),
          scopeLeaseFence:
            input.scope.kind === "unscoped" ? null : (input.scope.leaseFence ?? null),
          status: "pending",
          expiresAt: input.expiresAt,
        },
        select: commandColumns,
      });
      return toCommandRecord(row);
    },
    async getCommand(machineId, commandId) {
      const row = await prisma.machineCommand.findFirst({
        where: { id: commandId, machineId },
        select: commandColumns,
      });
      return row ? toCommandRecord(row) : null;
    },
    async claimNextCommand(machineId, now) {
      await prisma.machineCommand.updateMany({
        where: { machineId, status: { in: ["pending", "claimed"] }, expiresAt: { lte: now } },
        data: { status: "expired" },
      });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = await prisma.machineCommand.findFirst({
          where: { machineId, status: "pending" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, ...scopeSelect },
        });
        if (!candidate) return null;
        const claimed = await prisma.$transaction(async (tx) => {
          // Row-lock the machine so a concurrent revoke (which rewrites the
          // same row and tombstones commands) serializes with this claim: a
          // command handed out here is always backed by a live credential.
          await tx.$queryRaw`SELECT id FROM "machines" WHERE id = ${machineId} FOR UPDATE`;
          const machine = await tx.machine.findFirst({
            where: { id: machineId, status: "paired", credentialHash: { not: null } },
            select: { id: true },
          });
          if (!machine) return false;
          // Lock the command row so revoke's tombstone CAS cannot interleave.
          const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
            SELECT id, status FROM "machine_commands" WHERE id = ${candidate.id} FOR UPDATE`;
          if (locked[0]?.status !== "pending") return false;
          if (!(await scopeStillResolves(tx, machineId, now, candidate))) {
            await tx.machineCommand.updateMany({
              where: { id: candidate.id, machineId, status: "pending" },
              data: { status: "aborted" },
            });
            return false;
          }
          const updated = await tx.machineCommand.updateMany({
            where: { id: candidate.id, machineId, status: "pending" },
            data: { status: "claimed", claimedAt: now },
          });
          return updated.count === 1;
        });
        if (claimed) {
          const row = await prisma.machineCommand.findFirst({
            where: { id: candidate.id, machineId },
            select: commandColumns,
          });
          return row ? toCommandRecord(row) : null;
        }
      }
      return null;
    },
    async completeCommand(machineId, commandId, response, now) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let outcome: "accepted" | "already" | "missing" | "aborted";
        try {
          outcome = await prisma.$transaction(
            async (tx) => {
              // Serialize against revoke/claim on the machine row, then prove
              // the credential is still live and the command not expired.
              await tx.$queryRaw`SELECT id FROM "machines" WHERE id = ${machineId} FOR UPDATE`;
              const machine = await tx.machine.findFirst({
                where: { id: machineId, status: "paired", credentialHash: { not: null } },
                select: { id: true },
              });
              if (!machine) return "missing" as const;
              const locked = await tx.$queryRaw<{ id: string; status: string; expiresAt: Date }[]>`
                SELECT id, status, "expiresAt" FROM "machine_commands"
                WHERE id = ${commandId} AND "machineId" = ${machineId} FOR UPDATE`;
              const row = locked[0];
              if (!row) return "missing" as const;
              if (row.status === "completed" || row.status === "aborted") return "already" as const;
              if (row.status !== "claimed" || row.expiresAt.getTime() <= now.getTime()) {
                return "missing" as const;
              }
              const command = await tx.machineCommand.findFirstOrThrow({
                where: { id: commandId, machineId },
                select: { status: true, ...scopeSelect },
              });
              const resolves = await scopeStillResolves(tx, machineId, now, command);
              if (!resolves) {
                await tx.machineCommand.updateMany({
                  where: { id: commandId, machineId, status: "claimed" },
                  data: { status: "aborted" },
                });
                return "aborted" as const;
              }
              const updated = await tx.machineCommand.updateMany({
                where: { id: commandId, machineId, status: "claimed" },
                data: {
                  status: "completed",
                  responseStatus: response.status,
                  responseContentType: response.contentType,
                  responseBodyBase64: response.bodyBase64,
                  claimedAt: now,
                },
              });
              return updated.count === 1 ? ("accepted" as const) : ("missing" as const);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2034" &&
            attempt < 3
          ) {
            continue;
          }
          throw error;
        }
        return outcome;
      }
      return "missing";
    },
    async tombstoneCommand(machineId, commandId) {
      const updated = await prisma.machineCommand.updateMany({
        where: { id: commandId, machineId, status: { in: ["pending", "claimed"] } },
        data: { status: "aborted" },
      });
      return updated.count === 1;
    },
    async expireMachineCommands(machineId, now) {
      await prisma.machineCommand.updateMany({
        where: { machineId, status: { in: ["pending", "claimed"] }, expiresAt: { lte: now } },
        data: { status: "expired" },
      });
    },
  };
}

/** Completed/expired/aborted rows keep their request/response bodies for audit only briefly. */
export const MACHINE_COMMAND_RETENTION_MS = 60 * 60_000;

/**
 * Global bounded mailbox cleanup for the worker: expire stale in-flight
 * commands, then delete terminal commands (including their model payloads) in
 * batches so the mailbox cannot accumulate indefinitely. Claim paths also
 * expire lazily per machine.
 */
export async function sweepExpiredMachineCommands(
  prisma: PrismaClient,
  now = new Date(),
  options: { retentionMs?: number; batch?: number } = {},
): Promise<number> {
  const retentionMs = options.retentionMs ?? MACHINE_COMMAND_RETENTION_MS;
  const batch = options.batch ?? 200;
  const expired = await prisma.machineCommand.updateMany({
    where: { status: { in: ["pending", "claimed"] }, expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  let deleted = expired.count;
  const terminalBefore = new Date(now.getTime() - retentionMs);
  while (true) {
    const doomed = await prisma.machineCommand.findMany({
      where: {
        status: { in: ["completed", "expired", "failed", "aborted"] },
        expiresAt: { lt: terminalBefore },
      },
      select: { id: true },
      take: batch,
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    });
    if (doomed.length === 0) break;
    const removed = await prisma.machineCommand.deleteMany({
      where: { id: { in: doomed.map((row) => row.id) } },
    });
    deleted += removed.count;
    if (doomed.length < batch) break;
  }
  return deleted;
}

/** Raised when a tunnel request cannot be bound to a verifiable machine scope. */
export class MachineScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineScopeError";
  }
}

function parseLeaseFence(value: string | undefined): number | null {
  if (!value || !/^[0-9]{1,9}$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

interface ScopeRequestInfo {
  path: string;
  query?: string;
  headers: Record<string, string>;
}

/**
 * Resolve the durable scope of a tunnel request from the backend database so
 * claim time can prove the destination still belongs to the machine. Computer
 * refs are machine-local supervisor refs stored as `machine:<machineId>:<ref>`
 * providerRefs (or backend row ids); `x-rakazo-bot-id` carries the computer
 * homeKey. Agent scopes use the persisted root run (x-rakazo-root-run-id)
 * because child Pi runtimes send synthetic participant run ids. Every
 * run-bearing request must carry a complete lease; missing or malformed lease
 * headers reject instead of falling through to lease-less maintenance.
 */
export async function resolveMachineTunnelScope(
  prisma: PrismaClient,
  machineId: string,
  info: ScopeRequestInfo,
): Promise<MachineCommandScope> {
  const spaceId = info.headers["x-rakazo-space-id"];
  const homeKey = info.headers["x-rakazo-bot-id"];
  const runIdHeader = info.headers["x-rakazo-run-id"];
  const leaseOwner = info.headers["x-rakazo-lease-owner"];
  const leaseFence = parseLeaseFence(info.headers["x-rakazo-lease-fence"]);
  if (runIdHeader && (!leaseOwner || leaseFence == null)) {
    throw new MachineScopeError("Tunnel command carries a run id without a complete lease");
  }

  const computerMatch = /^\/computers\/([A-Za-z0-9._~-]+)(?:\/|$)/.exec(info.path);
  if (computerMatch) {
    const ref = computerMatch[1]!;
    let computer = await prisma.computer.findFirst({
      where: {
        OR: [
          { id: ref, machineId },
          { providerRef: `machine:${machineId}:${ref}`, machineId },
        ],
      },
      select: { id: true, spaceId: true, homeKey: true },
    });
    if (!computer && homeKey && spaceId) {
      computer = await prisma.computer.findFirst({
        where: { homeKey, spaceId, machineId, state: "booting" },
        select: { id: true, spaceId: true, homeKey: true },
      });
    }
    if (!computer) throw new MachineScopeError("Computer does not belong to this machine");
    if (spaceId !== computer.spaceId)
      throw new MachineScopeError("Computer space does not match the command");
    if (computer.homeKey !== homeKey) {
      throw new MachineScopeError("Computer home key does not match the command");
    }
    return {
      kind: "computer",
      spaceId: computer.spaceId,
      computerId: computer.id,
      ...(runIdHeader && leaseOwner && leaseFence != null
        ? { runId: runIdHeader, leaseOwner, leaseFence }
        : {}),
    };
  }

  // Provision and other id-less computer requests bind via homeKey + space.
  if (info.path === "/computers") {
    if (!homeKey || !spaceId) {
      throw new MachineScopeError("Computer provisioning requires home key and space headers");
    }
    const computer = await prisma.computer.findFirst({
      where: { homeKey, spaceId, machineId },
      select: { id: true, spaceId: true },
    });
    if (!computer) throw new MachineScopeError("No computer on this machine matches the request");
    return {
      kind: "computer",
      spaceId: computer.spaceId,
      computerId: computer.id,
      ...(runIdHeader && leaseOwner && leaseFence != null
        ? { runId: runIdHeader, leaseOwner, leaseFence }
        : {}),
    };
  }

  const rootRunId = info.headers["x-rakazo-root-run-id"] ?? runIdHeader;
  if (!rootRunId || !spaceId || !leaseOwner || leaseFence == null) {
    throw new MachineScopeError("Agent tunnel command requires root run and lease headers");
  }
  const run = await prisma.run.findFirst({
    where: { id: rootRunId, spaceId },
    select: { botId: true },
  });
  if (!run) throw new MachineScopeError("Run does not exist for this machine command");
  return {
    kind: "agent",
    spaceId,
    runId: rootRunId,
    botId: run.botId,
    leaseOwner,
    leaseFence,
  };
}

/** Resolve the computer or root-run authority before enqueueing a tunnel request. */
export function machineScopeFromTunnelRequest(
  prisma: PrismaClient,
  info: ScopeRequestInfo & { machineId: string },
): Promise<MachineCommandScope> {
  return resolveMachineTunnelScope(prisma, info.machineId, info);
}

export function createPrismaMachineScopeResolver(
  prisma: PrismaClient,
  machineId: string,
): (info: ScopeRequestInfo) => Promise<MachineCommandScope> {
  return async (info) => resolveMachineTunnelScope(prisma, machineId, info);
}

export interface MachineAssignmentResult {
  botId: string;
  machineId: string | null;
  computerId: string | null;
}

export async function machineAssignment(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  input: { botId: string },
): Promise<MachineAssignmentResult> {
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, computerId: true },
  });
  if (!bot) throw new IsolationError();
  if (!bot.computerId) return { botId: bot.id, machineId: null, computerId: null };
  const computer = await prisma.computer.findFirst({
    where: { id: bot.computerId, spaceId: actor.spaceId },
    select: { id: true, machineId: true },
  });
  return {
    botId: bot.id,
    machineId: computer?.machineId ?? null,
    computerId: computer?.id ?? null,
  };
}
