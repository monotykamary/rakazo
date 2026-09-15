import * as z from "zod";
import { Id } from "./ids.js";

/** Runner version suffix advertised on heartbeat when the office can own a run. */
export const OFFICE_REPLICA_VERSION_MARK = "office-replica";

export const OfficeReplicaStatusSchema = z.enum([
  "handing_off",
  "owning",
  "returning",
  "imported",
  "failed",
]);
export type OfficeReplicaStatus = z.infer<typeof OfficeReplicaStatusSchema>;

export const OfficeReplicaJournalTypeSchema = z.enum([
  "heartbeat",
  "event",
  "run_status",
  "effect",
]);
export type OfficeReplicaJournalType = z.infer<typeof OfficeReplicaJournalTypeSchema>;

export const OfficeReplicaJournalEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    prevHash: z.string().max(64),
    hash: z.string().min(64).max(64),
    type: OfficeReplicaJournalTypeSchema,
    occurredAt: z.string().min(1).max(40),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type OfficeReplicaJournalEntry = z.infer<typeof OfficeReplicaJournalEntrySchema>;

export const OfficeReplicaWorkModelSchema = z
  .object({
    provider: z.string().min(1).max(80),
    id: z.string().min(1).max(200),
    apiKey: z.string().max(8_000).optional(),
    baseUrl: z.string().url().max(500).optional(),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
  })
  .strict();

export const OfficeReplicaHistoryTurnSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(100_000),
  })
  .strict();

/** Claim payload. Model secrets are returned once over the runner TLS channel and never journaled. */
export const OfficeReplicaWorkSchema = z
  .object({
    replicaId: Id,
    epoch: z.number().int().nonnegative(),
    runId: Id,
    botId: Id,
    threadId: Id,
    spaceId: Id,
    computerId: Id,
    leaseFence: z.number().int().nonnegative(),
    prompt: z.string().max(100_000),
    instructions: z.string().max(100_000),
    history: z.array(OfficeReplicaHistoryTurnSchema).max(200),
    model: OfficeReplicaWorkModelSchema,
  })
  .strict();
export type OfficeReplicaWork = z.infer<typeof OfficeReplicaWorkSchema>;

export const OfficeReplicaClaimReplySchema = z
  .object({
    work: OfficeReplicaWorkSchema.nullable(),
  })
  .strict();

export const OfficeReplicaJournalBatchSchema = z
  .object({
    replicaId: Id,
    epoch: z.number().int().nonnegative(),
    entries: z.array(OfficeReplicaJournalEntrySchema).min(1).max(200),
  })
  .strict();
export type OfficeReplicaJournalBatch = z.infer<typeof OfficeReplicaJournalBatchSchema>;

export const OfficeReplicaReturnSchema = z
  .object({
    replicaId: Id,
    epoch: z.number().int().nonnegative(),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().max(4_000).optional(),
  })
  .strict();

export function machineSupportsOfficeReplica(version: string | null | undefined): boolean {
  return typeof version === "string" && version.includes(OFFICE_REPLICA_VERSION_MARK);
}

export function officeReplicaLeaseOwner(replicaId: string): string {
  return `office:${replicaId}`;
}

export function isOfficeReplicaLeaseOwner(leaseOwner: string | null | undefined): boolean {
  return typeof leaseOwner === "string" && leaseOwner.startsWith("office:");
}
