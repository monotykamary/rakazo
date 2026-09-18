import {
  type OfficeReplicaJournalEntry,
  OfficeReplicaStatusSchema,
  officeReplicaLeaseOwner,
} from "@rakazo/contracts";
import {
  OfficeReplicaJournalError,
  verifyOfficeReplicaBatch,
} from "@rakazo/core/node/office-replica";
import type { PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export { OfficeReplicaJournalError };

export async function handoffOfficeReplica(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    runId: string;
    machineId: string;
    leaseFence: number;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.officeReplica.findUnique({ where: { runId: input.runId } });
      if (existing) {
        if (existing.machineId !== input.machineId) {
          throw new OfficeReplicaJournalError("Run already handed to another office");
        }
        return existing;
      }
      const replica = await tx.officeReplica.create({
        data: {
          ...input,
          status: "handing_off",
          handedOffAt: new Date(),
        },
      });
      await tx.run.updateMany({
        where: { id: input.runId, spaceId: input.spaceId },
        data: {
          status: "running",
          leaseOwner: officeReplicaLeaseOwner(replica.id),
          leaseFence: input.leaseFence,
          leaseExpiresAt: null,
        },
      });
      return replica;
    }),
  );
}

export async function claimOfficeReplica(
  prisma: PrismaClient,
  input: { machineId: string; replicaId?: string },
) {
  const replica = await prisma.officeReplica.findFirst({
    where: {
      machineId: input.machineId,
      status: { in: ["handing_off", "owning"] },
      ...(input.replicaId ? { id: input.replicaId } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!replica) return null;
  if (replica.status === "handing_off") {
    await prisma.officeReplica.updateMany({
      where: { id: replica.id, status: "handing_off" },
      data: { status: "owning" },
    });
  }
  return replica;
}

export async function importOfficeReplicaJournal(
  prisma: PrismaClient,
  input: {
    replicaId: string;
    machineId: string;
    epoch: number;
    entries: OfficeReplicaJournalEntry[];
    appendEvent: (entry: OfficeReplicaJournalEntry) => Promise<void>;
  },
) {
  const replica = await prisma.officeReplica.findFirst({
    where: { id: input.replicaId, machineId: input.machineId },
  });
  if (!replica) throw new OfficeReplicaJournalError("Office replica not found");
  if (replica.epoch !== input.epoch) {
    throw new OfficeReplicaJournalError("Office replica epoch mismatch");
  }
  if (
    replica.status !== "owning" &&
    replica.status !== "handing_off" &&
    replica.status !== "returning"
  ) {
    throw new OfficeReplicaJournalError("Office replica is not accepting journal");
  }
  const verified = verifyOfficeReplicaBatch(
    replica.journalHead,
    replica.journalCursor,
    input.entries,
  );
  for (const entry of input.entries) {
    if (entry.type === "event" || entry.type === "run_status" || entry.type === "effect") {
      await input.appendEvent(entry);
    }
  }
  const status = replica.status === "handing_off" ? "owning" : replica.status;
  OfficeReplicaStatusSchema.parse(status);
  await prisma.officeReplica.update({
    where: { id: replica.id },
    data: {
      status,
      journalHead: verified.head,
      journalCursor: verified.cursor,
      lastJournalAt: new Date(),
    },
  });
  return verified;
}

export async function returnOfficeReplica(
  prisma: PrismaClient,
  input: {
    replicaId: string;
    machineId: string;
    epoch: number;
    outcome: "completed" | "failed" | "cancelled";
    error?: string;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const replica = await tx.officeReplica.findFirst({
        where: { id: input.replicaId, machineId: input.machineId, epoch: input.epoch },
      });
      if (!replica) throw new OfficeReplicaJournalError("Office replica not found");
      const status = input.outcome === "completed" ? "imported" : "failed";
      await tx.officeReplica.updateMany({
        where: { id: replica.id },
        data: {
          status,
          error: input.error ?? null,
          importedAt: new Date(),
        },
      });
      const runStatus =
        input.outcome === "completed"
          ? "completed"
          : input.outcome === "cancelled"
            ? "cancelled"
            : "failed";
      await tx.run.updateMany({
        where: { id: replica.runId, leaseOwner: officeReplicaLeaseOwner(replica.id) },
        data: {
          status: runStatus,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          ...(input.error ? { error: input.error } : {}),
        },
      });
      return { status, runId: replica.runId };
    }),
  );
}
