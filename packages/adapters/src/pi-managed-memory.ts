import type { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createMemoryProvider,
  createMemorySourceClient,
  createMemorySourceRegistry,
  MEMORY_SOURCE_INTERFACE_VERSION,
  type MemorySourceRecord,
} from "pi-fabric/memory";

export interface ManagedMemoryOptions {
  sessionManager?: () => SessionManager | undefined;
  stopped?: () => boolean;
}

/** Native retrieval over this participant's exact live checkpoint; no ambient discovery. */
export function managedMemoryProvider(
  runtime: () => AgentSessionRuntime | undefined,
  options: ManagedMemoryOptions = {},
) {
  const sourceId = "managed-session";
  const manager = () => {
    const value = runtime()?.session.sessionManager ?? options.sessionManager?.();
    if (!value) throw new Error("Session recall unavailable");
    return value;
  };
  const check = () => {
    if (options.stopped?.()) throw new Error("Managed execution paused");
  };
  const sources = createMemorySourceRegistry();
  sources.register({
    interfaceVersion: MEMORY_SOURCE_INTERFACE_VERSION,
    id: sourceId,
    authorize: () => !options.stopped?.(),
    async listSessions() {
      const sm = manager();
      return [{ sessionKey: sm.getSessionId(), revision: "live" }];
    },
    async loadSession(key) {
      const sm = manager();
      if (key !== sm.getSessionId()) return null;
      const header = sm.getHeader();
      if (!header) throw new Error("Session header unavailable");
      return {
        sessionKey: sm.getSessionId(),
        sessionId: sm.getSessionId(),
        revision: "live",
        records: [header, ...sm.getEntries()] as unknown as MemorySourceRecord[],
        selectedLeafId: sm.getLeafId(),
      };
    },
  });
  const client = createMemorySourceClient({ sources });
  const provider = createMemoryProvider({
    check,
    defaultSession: () => manager().getSessionId(),
    async dispatch(action, args, context) {
      if (args.source !== undefined && args.source !== sourceId) {
        throw new Error("Session recall outside current authority");
      }
      const id = manager().getSessionId();
      if (
        typeof args.scope === "string" &&
        args.scope.startsWith("session:") &&
        args.scope !== `session:${id}`
      ) {
        throw new Error("Session recall outside current authority");
      }
      const bound: Record<string, unknown> & { source: string } = { ...args, source: sourceId };
      if (action === "expand") {
        const session =
          args.session === undefined || args.session === "current" ? id : args.session;
        if (typeof session !== "string") throw new Error("Invalid memory session");
        return client.expand(
          { ...bound, session },
          context.signal ? { signal: context.signal } : {},
        );
      }
      if (args.scope === undefined || args.scope === "session" || args.scope === "current") {
        bound.scope = `session:${id}`;
      }
      return client[action](bound, context.signal ? { signal: context.signal } : {});
    },
  });
  return Object.assign(provider, { sourceId });
}
