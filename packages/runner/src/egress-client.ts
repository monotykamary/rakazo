import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { MACHINE_EGRESS_UPGRADE } from "@rakazo/contracts";
import { createEgressFrameReader, type EgressFrame, encodeEgressPacket } from "@rakazo/core";
import type { EgressTunnel } from "./egress-proxy.js";

export interface OfficeEgressClientOptions {
  serverUrl: string;
  token: string;
  signal?: AbortSignal;
}

type StreamHandlers = {
  onReady(): void;
  onData(bytes: Uint8Array): void;
  onClose(error?: string): void;
};

export type OfficeEgressClient = {
  open(target: { host: string; port: number }, handlers: StreamHandlers): EgressTunnel | null;
  close(): void;
};

export async function connectOfficeEgressClient(
  options: OfficeEgressClientOptions,
): Promise<OfficeEgressClient> {
  const url = new URL("/api/machines/runner/egress", options.serverUrl);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: MACHINE_EGRESS_UPGRADE,
        authorization: `Bearer ${options.token}`,
      },
    });
    req.on("upgrade", (_res, upgraded) => resolve(upgraded));
    req.on("error", reject);
    req.end();
    options.signal?.addEventListener(
      "abort",
      () => {
        req.destroy();
        reject(
          options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"),
        );
      },
      { once: true },
    );
  });

  let nextId = 1;
  const streams = new Map<number, StreamHandlers>();
  const send = (frame: EgressFrame) => {
    if (!socket.destroyed) socket.write(Buffer.from(encodeEgressPacket(frame)));
  };
  const reader = createEgressFrameReader(
    (frame) => {
      const handlers = streams.get(frame.id);
      if (!handlers) return;
      if (frame.type === "ready") handlers.onReady();
      else if (frame.type === "data") handlers.onData(frame.bytes);
      else if (frame.type === "close") {
        streams.delete(frame.id);
        handlers.onClose(frame.error);
      }
    },
    () => socket.destroy(),
  );
  socket.on("data", (chunk) => reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  socket.on("close", () => {
    for (const [id, handlers] of streams) {
      streams.delete(id);
      handlers.onClose("Desktop egress is disconnected");
    }
  });

  return {
    open(target, handlers) {
      if (socket.destroyed) return null;
      const id = nextId;
      nextId += 1;
      streams.set(id, handlers);
      send({ type: "open", id, host: target.host, port: target.port });
      return {
        write(bytes) {
          send({ type: "data", id, bytes });
        },
        close() {
          if (!streams.has(id)) return;
          streams.delete(id);
          send({ type: "close", id });
        },
      };
    },
    close() {
      if (!socket.destroyed) socket.destroy();
    },
  };
}
