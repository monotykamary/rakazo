import {
  type JsonRecord,
  MAX_RPC_FRAME_BYTES,
  type PrivateDuplex,
  record,
} from "./pi-rpc-protocol.js";

/** LF-only framing, incremental strict UTF-8 and byte (not character) limits. */
export async function* readJsonFrames(port: PrivateDuplex): AsyncGenerator<JsonRecord> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let bytes = 0;
  for await (const chunk of port.incoming) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      bytes += i - start;
      if (bytes > MAX_RPC_FRAME_BYTES) throw new Error("Managed RPC frame exceeds limit");
      buffered += decoder.decode(chunk.subarray(start, i), { stream: true });
      buffered += decoder.decode();
      if (!buffered.trim()) throw new Error("Empty managed RPC frame");
      yield record(JSON.parse(buffered));
      buffered = "";
      bytes = 0;
      start = i + 1;
    }
    bytes += chunk.length - start;
    if (bytes > MAX_RPC_FRAME_BYTES) throw new Error("Managed RPC frame exceeds limit");
    buffered += decoder.decode(chunk.subarray(start), { stream: true });
  }
  buffered += decoder.decode();
  if (bytes || buffered) throw new Error("Truncated managed RPC frame");
}

export class AsyncChannel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;
  constructor(private readonly limit = 1024) {}
  push(item: T): void {
    if (this.ended) return;
    if (this.items.length >= this.limit) throw new Error("Managed RPC consumer overflow");
    this.items.push(item);
    this.wake?.();
  }
  close(error?: Error): void {
    this.ended = true;
    this.error = error;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.error) throw this.error;
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/** A private, bounded correlated channel. No reconnection/replay after transport loss. */
export class JsonPeer {
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stopped?: Error;
  readonly finished: Promise<void>;
  constructor(
    readonly port: PrivateDuplex,
    private readonly handler: (message: JsonRecord) => Promise<unknown>,
    private readonly observe: (message: JsonRecord) => void = () => undefined,
    private readonly stock = false,
  ) {
    this.finished = this.read().catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error("Managed RPC disconnected"));
    });
  }
  private async read() {
    for await (const message of readJsonFrames(this.port)) {
      if (!this.stock && message.v !== 1) throw new Error("Managed RPC version mismatch");
      const id = typeof message.id === "string" ? message.id : undefined;
      if (message.type === "response" && id) {
        const pending = this.pending.get(id);
        if (!pending) throw new Error("Unknown managed RPC response");
        this.pending.delete(id);
        if (message.success === true) pending.resolve(message.data);
        else
          pending.reject(
            new Error(this.stock ? "Pi command rejected" : "Managed bridge operation rejected"),
          );
      } else if (message.type === "request" && id && !this.stock) {
        // Do not block the reader: reverse requests and model events can be interleaved.
        void this.handler(message)
          .then(
            (data) => this.send({ type: "response", id, success: true, data }),
            () => this.send({ type: "response", id, success: false }),
          )
          .catch((error: Error) => this.fail(error));
      } else this.observe(message);
    }
    throw new Error("Managed RPC disconnected");
  }
  fail(error: Error) {
    if (this.stopped) return;
    this.stopped = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.observe({ type: "disconnected", cause: error });
  }
  send(message: JsonRecord): Promise<void> {
    if (this.stopped) return Promise.reject(this.stopped);
    const bytes = new TextEncoder().encode(
      JSON.stringify(this.stock ? message : { v: 1, ...message }) + "\n",
    );
    if (bytes.length > MAX_RPC_FRAME_BYTES)
      return Promise.reject(new Error("Managed RPC output exceeds limit"));
    const next = this.writes.then(() => this.port.write(bytes));
    this.writes = next.catch((error: Error) => this.fail(error));
    return next;
  }
  request(operation: string, data?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.pending.size >= 128) return Promise.reject(new Error("Too many managed RPC requests"));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Managed RPC request timed out")), 300_000);
      const abort = () => finish(new Error("Managed RPC request aborted"));
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      const finish = (error: Error) => {
        cleanup();
        this.pending.delete(id);
        reject(error);
      };
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: finish,
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.send(
        this.stock
          ? { type: operation, ...record(data ?? {}), id }
          : { type: "request", operation, data, id },
      ).catch(finish);
    });
  }
  async close() {
    this.fail(new Error("Managed RPC closed"));
    await this.port.close();
  }
}
