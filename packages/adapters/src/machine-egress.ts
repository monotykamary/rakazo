import type { Actor, MachineEgressSnapshot } from "@rakazo/contracts";
import { MACHINE_EGRESS_MAX_STREAMS } from "@rakazo/contracts";
import { type EgressFrame, parseEgressTarget } from "@rakazo/core";

export type EgressActor = Pick<Actor, "spaceId" | "userId">;

export interface EgressPeer {
  send(frame: EgressFrame): void;
  close(): void;
}

export interface EgressAttachment {
  receive(frame: EgressFrame): void;
  dispose(): void;
}

export interface MachineEgressHub {
  snapshot(actor: EgressActor): Omit<MachineEgressSnapshot, "enabled">;
  attachHost(actor: EgressActor, peer: EgressPeer): EgressAttachment;
  attachClient(
    actor: EgressActor & { machineId: string },
    peer: EgressPeer,
  ): EgressAttachment | null;
  detachHost(actor: EgressActor): void;
}

type Stream = {
  clientId: number;
  hostId: number;
  machineId: string;
};

type Room = {
  host: EgressPeer | null;
  clients: Map<string, EgressPeer>;
  streams: Map<number, Stream>;
  byClient: Map<string, Map<number, number>>;
  nextHostId: number;
  active: number;
  sessionTotal: number;
};

function keyOf(actor: EgressActor): string {
  return `${actor.spaceId}:${actor.userId}`;
}

function targetOf(host: string, port: number) {
  return parseEgressTarget(`${host.includes(":") ? `[${host}]` : host}:${port}`);
}

export function createMachineEgressHub(): MachineEgressHub {
  const rooms = new Map<string, Room>();

  const roomOf = (actor: EgressActor): Room => {
    const key = keyOf(actor);
    const existing = rooms.get(key);
    if (existing) return existing;
    const created: Room = {
      host: null,
      clients: new Map(),
      streams: new Map(),
      byClient: new Map(),
      nextHostId: 1,
      active: 0,
      sessionTotal: 0,
    };
    rooms.set(key, created);
    return created;
  };

  const closeStream = (room: Room, hostId: number, error?: string, silentHost = false) => {
    const stream = room.streams.get(hostId);
    if (!stream) return;
    room.streams.delete(hostId);
    room.byClient.get(stream.machineId)?.delete(stream.clientId);
    room.active = Math.max(0, room.active - 1);
    room.clients.get(stream.machineId)?.send({
      type: "close",
      id: stream.clientId,
      ...(error ? { error } : {}),
    });
    if (!silentHost) {
      room.host?.send({ type: "close", id: hostId, ...(error ? { error } : {}) });
    }
  };

  const handleClient = (room: Room, machineId: string, frame: EgressFrame) => {
    if (frame.type === "open") {
      if (!room.host) {
        room.clients.get(machineId)?.send({
          type: "close",
          id: frame.id,
          error: "Desktop egress is disconnected",
        });
        return;
      }
      const target = targetOf(frame.host, frame.port);
      if (!target) {
        room.clients.get(machineId)?.send({
          type: "close",
          id: frame.id,
          error: "Egress destination is not allowed",
        });
        return;
      }
      const existing = room.byClient.get(machineId) ?? new Map<number, number>();
      if (
        existing.size >= MACHINE_EGRESS_MAX_STREAMS ||
        room.streams.size >= MACHINE_EGRESS_MAX_STREAMS
      ) {
        room.clients.get(machineId)?.send({
          type: "close",
          id: frame.id,
          error: "Too many egress connections",
        });
        return;
      }
      if (existing.has(frame.id)) {
        room.clients.get(machineId)?.send({
          type: "close",
          id: frame.id,
          error: "Duplicate egress stream",
        });
        return;
      }
      const hostId = room.nextHostId;
      room.nextHostId += 1;
      existing.set(frame.id, hostId);
      room.byClient.set(machineId, existing);
      room.streams.set(hostId, { clientId: frame.id, hostId, machineId });
      room.active += 1;
      room.sessionTotal += 1;
      room.host.send({ type: "open", id: hostId, host: target.host, port: target.port });
      return;
    }
    const hostId = room.byClient.get(machineId)?.get(frame.id);
    if (hostId === undefined) return;
    if (frame.type === "data") {
      room.host?.send({ type: "data", id: hostId, bytes: frame.bytes });
      return;
    }
    if (frame.type === "close") closeStream(room, hostId, frame.error);
  };

  const handleHost = (room: Room, frame: EgressFrame) => {
    const stream = room.streams.get(frame.id);
    if (!stream) return;
    const client = room.clients.get(stream.machineId);
    if (frame.type === "ready") {
      client?.send({ type: "ready", id: stream.clientId });
      return;
    }
    if (frame.type === "data") {
      client?.send({ type: "data", id: stream.clientId, bytes: frame.bytes });
      return;
    }
    if (frame.type === "close") closeStream(room, frame.id, frame.error, true);
  };

  return {
    snapshot(actor) {
      const room = rooms.get(keyOf(actor));
      return {
        hostConnected: Boolean(room?.host),
        activeConnections: room?.active ?? 0,
        sessionTotal: room?.sessionTotal ?? 0,
      };
    },
    attachHost(actor, peer) {
      const room = roomOf(actor);
      room.host?.close();
      room.host = peer;
      return {
        receive(frame) {
          if (room.host !== peer) return;
          handleHost(room, frame);
        },
        dispose() {
          if (room.host !== peer) return;
          for (const hostId of [...room.streams.keys()]) {
            closeStream(room, hostId, "Desktop egress is disconnected");
          }
          room.host = null;
        },
      };
    },
    attachClient(actor, peer) {
      const room = roomOf(actor);
      if (room.clients.has(actor.machineId)) return null;
      room.clients.set(actor.machineId, peer);
      return {
        receive(frame) {
          if (room.clients.get(actor.machineId) !== peer) return;
          handleClient(room, actor.machineId, frame);
        },
        dispose() {
          if (room.clients.get(actor.machineId) !== peer) return;
          for (const [hostId, stream] of [...room.streams]) {
            if (stream.machineId === actor.machineId) {
              closeStream(room, hostId, "Office disconnected");
            }
          }
          room.byClient.delete(actor.machineId);
          room.clients.delete(actor.machineId);
        },
      };
    },
    detachHost(actor) {
      const room = rooms.get(keyOf(actor));
      if (!room?.host) return;
      const host = room.host;
      for (const hostId of [...room.streams.keys()]) {
        closeStream(room, hostId, "Desktop egress is disconnected");
      }
      room.host = null;
      host.close();
    },
  };
}

export function mergeEgressSnapshot(
  preference: { enabled: boolean },
  runtime: Omit<MachineEgressSnapshot, "enabled">,
): MachineEgressSnapshot {
  return {
    enabled: preference.enabled,
    hostConnected: runtime.hostConnected,
    activeConnections: runtime.activeConnections,
    sessionTotal: runtime.sessionTotal,
  };
}
