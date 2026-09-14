import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateRemoteAddress, startOfficeEgressProxy } from "./egress-proxy.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

function listenEcho() {
  return new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const server = createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bind");
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("isPrivateRemoteAddress", () => {
  it("accepts loopback and RFC1918", () => {
    expect(isPrivateRemoteAddress("127.0.0.1")).toBe(true);
    expect(isPrivateRemoteAddress("10.0.0.4")).toBe(true);
    expect(isPrivateRemoteAddress("192.168.1.2")).toBe(true);
    expect(isPrivateRemoteAddress("172.18.0.4")).toBe(true);
    expect(isPrivateRemoteAddress("8.8.8.8")).toBe(false);
  });
});

describe("office egress proxy", () => {
  it("tunnels CONNECT after the desktop reports ready", async () => {
    const echo = await listenEcho();
    closers.push(echo.close);
    const proxy = await startOfficeEgressProxy({
      hostname: "127.0.0.1",
      mode: () => "desktop",
      openTunnel(target, handlers) {
        expect(target).toEqual({ host: "127.0.0.1", port: echo.port });
        queueMicrotask(() => handlers.onReady());
        return {
          write(bytes) {
            handlers.onData(bytes);
          },
          close() {
            handlers.onClose();
          },
        };
      },
    });
    closers.push(proxy.close);
    const { connect } = await import("node:net");
    const body = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\n\r\nping`);
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("ping")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
    });
    expect(body.startsWith("HTTP/1.1 200 Connection Established")).toBe(true);
    expect(body).toContain("ping");
  });

  it("fails closed when desktop routing is off", async () => {
    const proxy = await startOfficeEgressProxy({
      hostname: "127.0.0.1",
      mode: () => "off",
    });
    closers.push(proxy.close);
    const { connect } = await import("node:net");
    const body = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
      });
      socket.on("data", (chunk) => resolve(chunk.toString()));
      socket.on("error", reject);
    });
    expect(body.startsWith("HTTP/1.1 503")).toBe(true);
  });
});
