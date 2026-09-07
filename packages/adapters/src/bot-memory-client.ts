import {
  createMemorySourceClient,
  createMemorySourceRegistry,
  type PortableMemorySource,
} from "pi-fabric/memory";
import type { BotMemoryCall } from "./bot-starting-memory.js";

/** Bind a single authorized archive; model arguments cannot select another principal. */
export function botMemoryClient(
  source: PortableMemorySource,
  rootSignal: AbortSignal,
): BotMemoryCall {
  const sources = createMemorySourceRegistry();
  sources.register(source);
  const client = createMemorySourceClient({
    sources,
    config: { maxSessions: 32, maxSyncSessions: 32, maxSyncSourceBytes: 4 * 1024 * 1024 },
  });
  return async (action, args, signal) => {
    const combined = signal ? AbortSignal.any([rootSignal, signal]) : rootSignal;
    combined.throwIfAborted();
    if (args.source !== undefined && args.source !== source.id)
      return { error: { code: "source_unauthorized", message: "Memory source unavailable" } };
    if (!["recall", "expand", "sessions"].includes(action))
      return { error: { code: "invalid_arguments", message: "Unsupported memory action" } };
    const input = { ...args, source: source.id };
    const result =
      action === "expand"
        ? typeof args.session === "string"
          ? await client.expand({ ...input, session: args.session }, { signal: combined })
          : { error: { code: "invalid_arguments", message: "A session is required" } }
        : await client[action](input, { signal: combined });
    combined.throwIfAborted();
    // Recheck destination authority after async retrieval, not just before reading.
    if (
      source.authorize &&
      !(await source.authorize(action === "sessions" ? "list" : action, null))
    )
      return { error: { code: "source_unauthorized", message: "Memory source unavailable" } };
    return result;
  };
}
