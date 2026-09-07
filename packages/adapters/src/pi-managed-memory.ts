import { createHash } from "node:crypto";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/** Exact recall over the restored, fenced SessionManager, never a filesystem session discovery. */
export function managedMemoryProvider(runtime: () => AgentSessionRuntime | undefined) {
  const schema = {
    type: "object",
    properties: {
      session: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
      offset: { type: "number" },
      maxEntries: { type: "number" },
      maxChars: { type: "number" },
      sourceHash: { type: "string" },
      lineageFingerprint: { type: "string" },
      entryIds: { type: "array", items: { type: "string" } },
      indices: { type: "array", items: { type: "number" } },
      operationAddresses: { type: "array", items: { type: "string" } },
      entryRange: {
        type: "object",
        properties: { first: { type: "string" }, last: { type: "string" } },
        required: ["first", "last"],
      },
      textRange: {
        type: "object",
        properties: { start: { type: "number" }, end: { type: "number" } },
        required: ["start", "end"],
      },
    },
    additionalProperties: false,
  };
  const actions = ["recall", "expand", "sessions"].map((name) => ({
    name,
    description:
      "Recall exact source from this bot's authorized logical session. Entry IDs and nested operation addresses survive deterministic compaction.",
    inputSchema: schema,
    risk: "read",
  }));
  const hash = (values: readonly unknown[]) => {
    const digest = createHash("sha256");
    for (const value of values) digest.update(JSON.stringify(value)).update("\n");
    return "sha256:" + digest.digest("hex");
  };
  const cap = (value: unknown, fallback: number, max: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, max)
      : fallback;
  return {
    name: "memory",
    description: "Authorized logical-session source recall (in-memory, restored by the backend).",
    list: async () => actions,
    describe: async (name: string) => actions.find((action) => action.name === name),
    async invoke(name: string, args: Record<string, unknown>) {
      const session = runtime()?.session;
      if (!session) throw new Error("Session recall unavailable");
      const id = session.sessionId;
      if (args.session && args.session !== id && args.session !== "current")
        throw new Error("Session recall outside current authority");
      const entries = session.sessionManager.getBranch();
      if (name === "sessions")
        return {
          sessions: [
            {
              id,
              entryCount: entries.length,
              branches: 1,
              tier: "hot",
              lineageFingerprint: hash(entries.map((entry) => [entry.id, entry.parentId])),
            },
          ],
          scope: "session",
        };
      const offset = cap(args.offset, 0, entries.length);
      const limit = Math.max(1, cap(args.limit ?? args.maxEntries, 20, 100));
      const maxChars = Math.max(1, cap(args.maxChars, 16000, 64000));
      if (name === "recall") {
        const query = String(args.query ?? "").toLowerCase();
        let scannedChars = 0;
        let scannedEntries = 0;
        const found = [];
        for (const [index, entry] of entries.entries()) {
          if (scannedEntries >= 10000 || scannedChars >= 8 * 1024 * 1024) break;
          const text = JSON.stringify(entry);
          scannedChars += text.length;
          scannedEntries++;
          if (query && !text.toLowerCase().includes(query)) continue;
          found.push({
            kind: "entry",
            sessionId: id,
            tier: "hot",
            index,
            entryId: entry.id,
            parentId: entry.parentId,
            type: entry.type,
            snippet: text.slice(0, 512),
            truncated: text.length > 512,
            follow: { ref: "memory.expand", args: { session: id, entryIds: [entry.id] } },
          });
        }
        return {
          total: found.length,
          hits: found.slice(offset, offset + limit),
          next:
            offset + limit < found.length
              ? { ref: "memory.recall", args: { ...args, offset: offset + limit } }
              : null,
          coverage: {
            complete: scannedEntries === entries.length,
            indexedSessions: 1,
            eligibleSessions: 1,
            staleSessions: 0,
            incompleteSessions: scannedEntries < entries.length ? 1 : 0,
            reasons: scannedEntries < entries.length ? ["managed_scan_limit"] : [],
          },
        };
      }
      if (name !== "expand") throw new Error("Unknown memory action");
      const ids = new Set(Array.isArray(args.entryIds) ? args.entryIds : []);
      const operations = Array.isArray(args.operationAddresses)
        ? (args.operationAddresses as string[])
        : [];
      for (const address of operations) ids.add(address.split("/")[0]);
      const range = args.entryRange as { first: string; last: string } | undefined;
      const first = range ? entries.findIndex((entry) => entry.id === range.first) : -1;
      const last = range ? entries.findIndex((entry) => entry.id === range.last) : -1;
      if (range && (first < 0 || last < first)) throw new Error("Unknown source entry range");
      const selected = entries.filter(
        (entry, index) =>
          ids.has(entry.id) ||
          (Array.isArray(args.indices) && args.indices.includes(index)) ||
          (range && index >= first && index <= last),
      );
      if (!selected.length) throw new Error("Exact source selector required or no matching entry");
      if (selected.length > 10000) throw new Error("Source range exceeds managed expansion limit");
      const sourceHash = hash(selected);
      const lineageFingerprint = hash(selected.map((entry) => [entry.id, entry.parentId]));
      if (
        (args.sourceHash && args.sourceHash !== sourceHash) ||
        (args.lineageFingerprint && args.lineageFingerprint !== lineageFingerprint)
      )
        throw new Error("Recall source changed; obtain a fresh source address");
      const textRange = args.textRange as { start: number; end: number } | undefined;
      let remaining = maxChars;
      const expanded = [];
      for (const [ordinal, entry] of selected.slice(offset, offset + limit).entries()) {
        const text = JSON.stringify(entry);
        const start = textRange && ordinal === 0 ? cap(textRange.start, 0, text.length) : 0;
        const end = Math.min(
          text.length,
          start + remaining,
          textRange && ordinal === 0 ? cap(textRange.end, text.length, text.length) : text.length,
        );
        const chunk = text.slice(start, end);
        expanded.push({
          entryId: entry.id,
          parentId: entry.parentId,
          type: entry.type,
          text: chunk,
          textRange: { start, end },
          totalChars: text.length,
          truncated: end < text.length,
          ...(start === 0 && end === text.length ? { entry } : {}),
        });
        remaining -= chunk.length;
        if (end < text.length)
          return {
            session: id,
            sourceHash,
            lineageFingerprint,
            entries: expanded,
            next: {
              ref: "memory.expand",
              args: {
                ...args,
                session: id,
                offset: offset + ordinal,
                textRange: { start: end, end: text.length },
                maxChars,
                sourceHash,
                lineageFingerprint,
              },
            },
          };
        if (!remaining) break;
      }
      return {
        session: id,
        sourceHash,
        lineageFingerprint,
        entries: expanded,
        next:
          offset + expanded.length < selected.length
            ? {
                ref: "memory.expand",
                args: {
                  ...args,
                  textRange: undefined,
                  offset: offset + expanded.length,
                  sourceHash,
                  lineageFingerprint,
                },
              }
            : null,
      };
    },
  };
}
