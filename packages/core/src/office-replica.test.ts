import { describe, expect, it } from "vitest";
import {
  OfficeReplicaJournalError,
  sealOfficeReplicaEntry,
  verifyOfficeReplicaBatch,
} from "./office-replica.js";

function entry(seq: number, prevHash: string, payload: Record<string, unknown> = { n: seq }) {
  return sealOfficeReplicaEntry(prevHash, {
    seq,
    type: "heartbeat",
    occurredAt: "2026-09-15T00:00:00.000Z",
    payload,
  });
}

describe("office replica journal", () => {
  it("chains hashes so a gap or edit fails closed", () => {
    const first = entry(0, "");
    const second = entry(1, first.hash);
    expect(verifyOfficeReplicaBatch("", -1, [first, second])).toEqual({
      head: second.hash,
      cursor: 1,
    });
    expect(() => verifyOfficeReplicaBatch("", -1, [second])).toThrow(OfficeReplicaJournalError);
    expect(() =>
      verifyOfficeReplicaBatch(first.hash, 0, [{ ...second, prevHash: "0".repeat(64) }]),
    ).toThrow(/chain/);
  });

  it("rejects a broken hash even when seq is consecutive", () => {
    const first = entry(0, "");
    const second = entry(1, first.hash);
    expect(() =>
      verifyOfficeReplicaBatch("", -1, [first, { ...second, hash: first.hash }]),
    ).toThrow(/hash mismatch/);
  });
});
