import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

export type JournalState = "started" | "completed" | "delivered";

export interface JournalEntry {
  deliveryId: string;
  method: string;
  path: string;
  state: JournalState;
  status?: number;
  bodyBase64?: string;
  contentType?: string;
}

const MAX_ENTRIES_BEFORE_COMPACT = 2048;
const COMPLETED_KEEP_LIMIT = 256;

/**
 * Durable local record of tunnel command handling. Commands are claimed exactly once by
 * the server, so this journal is never a replay queue: after a crash it only proves what
 * already ran so an uncertain mutation can be failed closed instead of executed twice.
 */
export class ForwardJournal {
  private entries = new Map<string, JournalEntry>();

  private constructor(private readonly filePath: string) {}

  static async load(filePath: string): Promise<ForwardJournal> {
    const journal = new ForwardJournal(filePath);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return journal;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = ForwardJournal.parseEntry(line);
        if (entry) journal.entries.set(entry.deliveryId, entry);
      } catch {
        // A torn tail from a crash mid-write is expected; drop the partial record.
      }
    }
    return journal;
  }

  private static parseEntry(line: string): JournalEntry | undefined {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.deliveryId !== "string" || !value.deliveryId) return undefined;
    if (typeof value.method !== "string" || typeof value.path !== "string") return undefined;
    if (value.state !== "started" && value.state !== "completed" && value.state !== "delivered") {
      return undefined;
    }
    const status = typeof value.status === "number" ? value.status : undefined;
    if (value.state !== "started" && status === undefined) return undefined;
    if (value.state === "started") {
      return {
        deliveryId: value.deliveryId,
        method: value.method,
        path: value.path,
        state: value.state,
      };
    }
    return {
      deliveryId: value.deliveryId,
      method: value.method,
      path: value.path,
      state: value.state,
      status,
      ...(typeof value.bodyBase64 === "string" ? { bodyBase64: value.bodyBase64 } : {}),
      ...(typeof value.contentType === "string" ? { contentType: value.contentType } : {}),
    };
  }

  lookup(deliveryId: string): JournalEntry | undefined {
    return this.entries.get(deliveryId);
  }

  async begin(deliveryId: string, method: string, path: string): Promise<void> {
    const entry: JournalEntry = { deliveryId, method, path, state: "started" };
    await this.append(entry);
    this.entries.set(deliveryId, entry);
  }

  async complete(
    deliveryId: string,
    status: number,
    bodyBase64?: string,
    contentType?: string,
  ): Promise<void> {
    const prior = this.entries.get(deliveryId);
    const entry: JournalEntry = {
      deliveryId,
      method: prior?.method ?? "",
      path: prior?.path ?? "",
      state: "completed",
      status,
      ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
      ...(contentType === undefined ? {} : { contentType }),
    };
    await this.append(entry);
    this.entries.set(deliveryId, entry);
    await this.compactIfBounded();
  }

  /** Completed results whose delivery was never acked still need a recovery re-post. */
  pendingResults(): JournalEntry[] {
    return [...this.entries.values()].filter((entry) => entry.state === "completed");
  }

  async markDelivered(deliveryId: string): Promise<void> {
    const prior = this.entries.get(deliveryId);
    if (prior?.state !== "completed") return;
    const entry: JournalEntry = { ...prior, state: "delivered" };
    await this.append(entry);
    this.entries.set(deliveryId, entry);
    await this.compactIfBounded();
  }

  private async append(entry: JournalEntry): Promise<void> {
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Keep the journal bounded: drop old terminal records, keep every started one. */
  private async compactIfBounded(): Promise<void> {
    if (this.entries.size <= MAX_ENTRIES_BEFORE_COMPACT) return;
    const terminal = [...this.entries.values()].filter((entry) => entry.state !== "started");
    const keepTerminal = new Set(terminal.slice(-COMPLETED_KEEP_LIMIT).map((e) => e.deliveryId));
    const kept = [...this.entries.values()].filter(
      (entry) => entry.state === "started" || keepTerminal.has(entry.deliveryId),
    );
    const temp = `${this.filePath}.compact.${process.pid}.tmp`;
    try {
      await writeFile(
        temp,
        kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : ""),
        {
          mode: 0o600,
        },
      );
      await rename(temp, this.filePath);
      this.entries = new Map(kept.map((entry) => [entry.deliveryId, entry]));
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
