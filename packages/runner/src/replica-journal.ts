import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type OfficeReplicaJournalEntry,
  OfficeReplicaJournalEntrySchema,
} from "@rakazo/contracts";
import { sealOfficeReplicaEntry, verifyOfficeReplicaBatch } from "@rakazo/core";

export class ReplicaJournal {
  private entries: OfficeReplicaJournalEntry[] = [];
  private flushed = -1;

  private constructor(
    private readonly filePath: string,
    private head: string,
    private cursor: number,
  ) {}

  static async load(home: string, replicaId: string): Promise<ReplicaJournal> {
    const directory = path.join(home, "replicas");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${replicaId}.jsonl`);
    const journal = new ReplicaJournal(filePath, "", -1);
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return journal;
    }
    const loaded: OfficeReplicaJournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        loaded.push(OfficeReplicaJournalEntrySchema.parse(JSON.parse(line)));
      } catch {
        break;
      }
    }
    if (loaded.length) {
      const verified = verifyOfficeReplicaBatch("", -1, loaded);
      journal.entries = loaded;
      journal.head = verified.head;
      journal.cursor = verified.cursor;
    }
    return journal;
  }

  get nextSeq() {
    return this.cursor + 1;
  }

  unflushed(): OfficeReplicaJournalEntry[] {
    return this.entries.filter((entry) => entry.seq > this.flushed);
  }

  markFlushed(cursor: number) {
    if (cursor > this.flushed) this.flushed = cursor;
  }

  async append(
    type: OfficeReplicaJournalEntry["type"],
    payload: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): Promise<OfficeReplicaJournalEntry> {
    const sealed = sealOfficeReplicaEntry(this.head, {
      seq: this.nextSeq,
      type,
      occurredAt,
      payload,
    });
    this.entries.push(sealed);
    this.head = sealed.hash;
    this.cursor = sealed.seq;
    await this.persist();
    return sealed;
  }

  private async persist() {
    const tmp = `${this.filePath}.tmp`;
    const body = `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
