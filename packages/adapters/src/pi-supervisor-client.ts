import {
  type AgentProcessHost,
  type AgentProcessScope,
  MAX_RPC_FRAME_BYTES,
  type PrivateDuplex,
  record,
} from "./pi-rpc-protocol.js";
import { AsyncChannel } from "./pi-rpc-transport.js";

/** Private composition-root configuration; never accept this URL/token from a run. */
export class SupervisorAgentProcessHost implements AgentProcessHost {
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch }) {}
  async start(scope: Readonly<AgentProcessScope>, signal: AbortSignal) {
    signal.throwIfAborted();
    const frozen = Object.freeze({ ...scope });
    const headers = {
      authorization: `Bearer ${this.options.token}`,
      "content-type": "application/json",
      "x-rakazo-run-id": frozen.runId,
      "x-rakazo-bot-id": frozen.botId,
      "x-rakazo-space-id": frozen.spaceId,
    };
    const http = this.options.fetch ?? fetch;
    const base = this.options.baseUrl.replace(/\/$/, "");
    const request = async (path: string, init: RequestInit = {}, operationSignal?: AbortSignal) => {
      const response = await http(`${base}${path}`, {
        ...init,
        headers,
        signal: operationSignal ?? AbortSignal.timeout(35_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Isolated Pi supervisor request failed");
      const text = await response.text();
      if (text.length > MAX_RPC_FRAME_BYTES * 2)
        throw new Error("Supervisor response exceeds limit");
      return text ? record(JSON.parse(text)) : {};
    };
    // Do not cancel creation mid-response: retain the id so cleanup can always reap it.
    const created = await request("/agents", {
      method: "POST",
      body: JSON.stringify({ runId: frozen.runId, botId: frozen.botId, spaceId: frozen.spaceId }),
    });
    if (typeof created.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(created.id))
      throw new Error("Invalid isolated process identity");
    const path = `/agents/${created.id}`;
    const controller = new AbortController();
    const rpc = new AsyncChannel<Uint8Array>(64);
    const bridge = new AsyncChannel<Uint8Array>(64);
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= (async () => {
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        try {
          await request(path, { method: "DELETE" });
        } finally {
          rpc.close();
          bridge.close();
        }
      })());
    const onAbort = () => {
      void stop().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      await stop();
      signal.throwIfAborted();
    }
    const port = (
      channel: "rpc" | "bridge",
      incoming: AsyncChannel<Uint8Array>,
    ): PrivateDuplex => ({
      incoming,
      async write(frame) {
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (frame.length > MAX_RPC_FRAME_BYTES || frame.at(-1) !== 10)
          throw new Error("Invalid supervisor input frame");
        await request(
          `${path}/input`,
          {
            method: "POST",
            body: JSON.stringify({
              channel,
              data: new TextDecoder("utf-8", { fatal: true }).decode(frame),
            }),
          },
          controller.signal,
        );
      },
      close: stop,
    });
    void (async () => {
      let cursor = -1;
      try {
        while (!controller.signal.aborted) {
          const batch = await request(`${path}/events?cursor=${cursor}`, {}, controller.signal);
          if (
            !Array.isArray(batch.frames) ||
            typeof batch.cursor !== "number" ||
            batch.cursor < cursor
          )
            throw new Error("Invalid supervisor event cursor");
          for (const value of batch.frames) {
            const frame = record(value);
            if (
              typeof frame.seq !== "number" ||
              frame.seq !== cursor + 1 ||
              typeof frame.data !== "string"
            )
              throw new Error("Lost isolated Pi output frames");
            cursor = frame.seq;
            const bytes = new TextEncoder().encode(frame.data);
            if (bytes.length > MAX_RPC_FRAME_BYTES)
              throw new Error("Supervisor frame exceeds limit");
            if (frame.channel === "rpc") rpc.push(bytes);
            else if (frame.channel === "bridge") bridge.push(bytes);
            // stderr is deliberately not exposed: extensions/providers can log secrets.
            else if (frame.channel !== "stderr" && frame.channel !== "exit")
              throw new Error("Invalid supervisor channel");
          }
          if (batch.cursor !== cursor) throw new Error("Supervisor skipped output");
          if (batch.closed) break;
        }
        rpc.close();
        bridge.close();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Isolated Pi transport failed");
        rpc.close(failure);
        bridge.close(failure);
      } finally {
        await stop().catch(() => undefined);
      }
    })();
    return { rpc: port("rpc", rpc), bridge: port("bridge", bridge), stop };
  }
}
