import { mkdtemp, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import path from "node:path";
  import { afterEach, describe, expect, it } from "vitest";
  import { ReplicaJournal } from "./replica-journal.js";

  let home = "";
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  describe("replica journal", () => {
    it("reloads a hash chain after a crash and only flushes new seqs", async () => {
      home = await mkdtemp(path.join(tmpdir(), "rakazo-replica-"));
      const first = await ReplicaJournal.load(home, "rep1");
      await first.append("heartbeat", { n: 1 });
      await first.append("event", { type: "run.started", runId: "run1" });
      first.markFlushed(0);
      expect(first.unflushed().map((entry) => entry.seq)).toEqual([1]);
      const reloaded = await ReplicaJournal.load(home, "rep1");
      expect(reloaded.nextSeq).toBe(2);
      expect(reloaded.unflushed().map((entry) => entry.seq)).toEqual([0, 1]);
    });
  });
