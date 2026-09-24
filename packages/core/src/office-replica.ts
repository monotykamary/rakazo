import { createHash } from "node:crypto";
import { type OfficeReplicaJournalEntry, OfficeReplicaJournalEntrySchema } from "@rakazo/contracts";

const HASH_BYTES = 32;

function canonicalPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function hashOfficeReplicaEntry(
  prevHash: string,
  entry: Pick<OfficeReplicaJournalEntry, "seq" | "type" | "occurredAt" | "payload">,
): string {
  const digest = createHash("sha256");
  digest.update(prevHash);
  digest.update("\n");
  digest.update(String(entry.seq));
  digest.update("\n");
  digest.update(entry.type);
  digest.update("\n");
  digest.update(entry.occurredAt);
  digest.update("\n");
  digest.update(canonicalPayload(entry.payload));
  return digest.digest("hex");
}

export function sealOfficeReplicaEntry(
  prevHash: string,
  entry: Omit<OfficeReplicaJournalEntry, "prevHash" | "hash">,
): OfficeReplicaJournalEntry {
  const sealed = {
    ...entry,
    prevHash,
    hash: hashOfficeReplicaEntry(prevHash, entry),
  };
  return OfficeReplicaJournalEntrySchema.parse(sealed);
}

export class OfficeReplicaJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficeReplicaJournalError";
  }
}

/** Verify a consecutive batch against the imported head. Never skips or rewrites seq. */
export function verifyOfficeReplicaBatch(
  head: string,
  cursor: number,
  entries: OfficeReplicaJournalEntry[],
): { head: string; cursor: number } {
  if (entries.length === 0) throw new OfficeReplicaJournalError("Empty replica journal batch");
  let prevHash = head;
  let seq = cursor;
  for (const entry of entries) {
    const parsed = OfficeReplicaJournalEntrySchema.parse(entry);
    if (parsed.seq !== seq + 1) {
      throw new OfficeReplicaJournalError(
        `Replica journal seq gap: expected ${seq + 1}, got ${parsed.seq}`,
      );
    }
    if (parsed.prevHash !== prevHash) {
      throw new OfficeReplicaJournalError("Replica journal chain does not match imported head");
    }
    const expected = hashOfficeReplicaEntry(prevHash, parsed);
    if (parsed.hash !== expected || parsed.hash.length !== HASH_BYTES * 2) {
      throw new OfficeReplicaJournalError("Replica journal hash mismatch");
    }
    prevHash = parsed.hash;
    seq = parsed.seq;
  }
  return { head: prevHash, cursor: seq };
}
