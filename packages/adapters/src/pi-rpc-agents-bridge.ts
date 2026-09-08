import type { AgentServiceDispatcher } from "pi-fabric/agents";
import { agentAction, record, string } from "./pi-rpc-protocol.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

/** One authenticated worker connection; caller identity is closed over by the handler. */
export class AgentsBridge {
  private readonly used = new Set<string>();
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly dispatch: AgentServiceDispatcher) {}

  async invoke(value: unknown): Promise<unknown> {
    const input = record(value);
    const callId = string(input.callId);
    const action = agentAction(input.action);
    const args = record(input.args);
    if (Object.keys(input).some((key) => !["callId", "action", "args"].includes(key)))
      throw new Error("Invalid managed agents request");
    if (this.used.has(callId)) throw new Error("Managed agents invocation cannot be replayed");
    this.used.add(callId);
    const controller = new AbortController();
    this.pending.set(callId, controller);
    try {
      return await this.dispatch(action, args, controller.signal);
    } finally {
      this.pending.delete(callId);
    }
  }

  cancel(value: unknown): void {
    const input = record(value);
    if (Object.keys(input).some((key) => key !== "callId"))
      throw new Error("Invalid managed agents cancellation");
    this.pending.get(string(input.callId))?.abort();
  }

  close(): void {
    for (const controller of this.pending.values()) controller.abort();
  }
}

/** Cancel the service waiter/preparation, not its admitted execution owner. Never retry. */
export function createPrivateAgentsDispatcher(peer: JsonPeer): AgentServiceDispatcher {
  return async (action, args, signal) => {
    signal?.throwIfAborted();
    const callId = crypto.randomUUID();
    const cancel = () => {
      void peer.request("agents_cancel", { callId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Keep correlation alive until the backend acknowledges cancellation. Dropping a
      // JsonPeer waiter early would turn its late response into a protocol failure.
      const result = await peer.request("agents", { callId, action, args });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
}
