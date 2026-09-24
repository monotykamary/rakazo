import { connect, createServer, type Socket } from "node:net";
import { parseEgressTarget } from "@rakazo/core";

export type OfficeEgressMode = "off" | "direct" | "desktop";

export type EgressTunnel = {
  write(bytes: Uint8Array): void;
  close(): void;
};

export interface OfficeEgressProxyOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  mode: () => OfficeEgressMode;
  /** Used when mode is `desktop`: open a tunneled TCP stream. */
  openTunnel?: (
    target: { host: string; port: number },
    handlers: { onReady(): void; onData(bytes: Uint8Array): void; onClose(error?: string): void },
  ) => EgressTunnel | null;
}

const HEADER_LIMIT = 8 * 1024;

export function isPrivateRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "127.0.0.1" || address === "::1" || address === "localhost") return true;
  if (address.startsWith("::ffff:")) return isPrivateRemoteAddress(address.slice(7));
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

function parseConnectHead(buffer: Buffer): { target: string; rest: Buffer } | "need" | "bad" {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) return buffer.length > HEADER_LIMIT ? "bad" : "need";
  const head = buffer.subarray(0, end).toString("latin1");
  const line = head.split("\r\n")[0] ?? "";
  const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/i.exec(line);
  if (!match) return "bad";
  return { target: match[1] ?? "", rest: buffer.subarray(end + 4) };
}

function fail(socket: Socket, status: number, reason: string) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.end();
}

function pipeDirect(target: { host: string; port: number }, socket: Socket, rest: Buffer) {
  const remote = connect({ host: target.host, port: target.port }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length) remote.write(rest);
    socket.pipe(remote);
    remote.pipe(socket);
  });
  remote.on("error", () => fail(socket, 502, "Bad Gateway"));
  socket.on("close", () => remote.destroy());
}

export function startOfficeEgressProxy(options: OfficeEgressProxyOptions): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      if (!isPrivateRemoteAddress(socket.remoteAddress)) {
        socket.destroy();
        return;
      }
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseConnectHead(buffer);
        if (parsed === "need") return;
        socket.off("data", onData);
        if (parsed === "bad") {
          fail(socket, 400, "Bad Request");
          return;
        }
        const target = parseEgressTarget(parsed.target);
        if (!target) {
          fail(socket, 400, "Bad Request");
          return;
        }
        const mode = options.mode();
        if (mode === "off") {
          fail(socket, 503, "Service Unavailable");
          return;
        }
        if (mode === "direct") {
          pipeDirect(target, socket, parsed.rest);
          return;
        }
        if (!options.openTunnel) {
          fail(socket, 503, "Service Unavailable");
          return;
        }
        let stream: EgressTunnel | null = null;
        stream = options.openTunnel(target, {
          onReady() {
            if (socket.destroyed || !stream) return;
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (parsed.rest.length) stream.write(parsed.rest);
            socket.on("data", (data) => {
              stream?.write(typeof data === "string" ? Buffer.from(data) : data);
            });
          },
          onData(bytes) {
            if (!socket.destroyed) socket.write(Buffer.from(bytes));
          },
          onClose() {
            if (!socket.destroyed) socket.end();
          },
        });
        if (!stream) {
          fail(socket, 503, "Service Unavailable");
          return;
        }
        socket.on("close", () => stream?.close());
        socket.on("error", () => stream?.close());
      };
      socket.on("data", onData);
      socket.on("error", () => undefined);
    });

    const onAbort = () => {
      server.close();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Egress proxy failed to bind"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            options.signal?.removeEventListener("abort", onAbort);
            server.close(() => done());
          }),
      });
    });
  });
}
