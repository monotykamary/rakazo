import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket as TcpSocket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Session } from "electron";
import { MACHINE_EGRESS_UPGRADE } from "@rakazo/contracts";
import {
  createEgressFrameReader,
  encodeEgressPacket,
  type EgressFrame,
  parseEgressTarget,
} from "@rakazo/core";

export type OfficeEgressHostState = {
  connected: boolean;
  activeConnections: number;
  sessionTotal: number;
};

export interface OfficeEgressHost {
  start(input: { origin: string; spaceId: string; session: Session }): Promise<void>;
  stop(): void;
  state(): OfficeEgressHostState;
  onChange(listener: (state: OfficeEgressHostState) => void): () => void;
}

export function createOfficeEgressHost(): OfficeEgressHost {
  let socket: TcpSocket | null = null;
  let active = 0;
  let sessionTotal = 0;
  const listeners = new Set<(state: OfficeEgressHostState) => void>();
  const streams = new Map<number, TcpSocket>();

  const emit = () => {
    const snapshot = {
      connected: Boolean(socket && !socket.destroyed),
      activeConnections: active,
      sessionTotal,
    };
    for (const listener of listeners) listener(snapshot);
  };

  const send = (frame: EgressFrame) => {
    if (socket && !socket.destroyed) socket.write(Buffer.from(encodeEgressPacket(frame)));
  };

  const closeStream = (id: number) => {
    const remote = streams.get(id);
    if (!remote) return;
    streams.delete(id);
    active = Math.max(0, active - 1);
    remote.destroy();
    emit();
  };

  const handle = (frame: EgressFrame) => {
    if (frame.type === "open") {
      const target = parseEgressTarget(
        `${frame.host.includes(":") ? `[${frame.host}]` : frame.host}:${frame.port}`,
      );
      if (!target) {
        send({ type: "close", id: frame.id, error: "Egress destination is not allowed" });
        return;
      }
      const remote = connect({ host: target.host, port: target.port }, () => {
        send({ type: "ready", id: frame.id });
      });
      streams.set(frame.id, remote);
      active += 1;
      sessionTotal += 1;
      emit();
      remote.on("data", (chunk) =>
        send({ type: "data", id: frame.id, bytes: typeof chunk === "string" ? Buffer.from(chunk) : chunk }),
      );
      remote.on("close", () => {
        if (!streams.has(frame.id)) return;
        closeStream(frame.id);
        send({ type: "close", id: frame.id });
      });
      remote.on("error", () => {
        closeStream(frame.id);
        send({ type: "close", id: frame.id, error: "Desktop could not connect" });
      });
      return;
    }
    const remote = streams.get(frame.id);
    if (!remote) return;
    if (frame.type === "data") {
      remote.write(Buffer.from(frame.bytes));
      return;
    }
    closeStream(frame.id);
  };

  return {
    async start(input) {
      this.stop();
      const cookies = await input.session.cookies.get({ url: input.origin });
      const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
      const url = new URL("/api/machines/egress/host", input.origin);
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      socket = await new Promise<TcpSocket>((resolve, reject) => {
        const req = request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "GET",
          headers: {
            connection: "Upgrade",
            upgrade: MACHINE_EGRESS_UPGRADE,
            cookie,
            "x-rakazo-space-id": input.spaceId,
          },
        });
        req.on("upgrade", (_res: IncomingMessage, upgraded: TcpSocket) => resolve(upgraded));
        req.on("error", reject);
        req.end();
      });
      const reader = createEgressFrameReader(handle, () => socket?.destroy());
      socket.on("data", (chunk) => reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      socket.on("close", () => {
        for (const id of [...streams.keys()]) closeStream(id);
        socket = null;
        emit();
      });
      emit();
    },
    stop() {
      for (const id of [...streams.keys()]) closeStream(id);
      socket?.destroy();
      socket = null;
      emit();
    },
    state() {
      return {
        connected: Boolean(socket && !socket.destroyed),
        activeConnections: active,
        sessionTotal,
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
