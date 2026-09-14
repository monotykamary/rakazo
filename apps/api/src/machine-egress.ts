import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Auth } from "@rakazo/auth";
import {
  MACHINE_EGRESS_UPGRADE,
  type MachineEgressSnapshot,
} from "@rakazo/contracts";
import {
  createEgressFrameReader,
  encodeEgressPacket,
  type EgressFrame,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { requireMembership } from "@rakazo/db";
import type { MachineEgressHub, EgressPeer } from "@rakazo/adapters";
import { mergeEgressSnapshot } from "@rakazo/adapters";
import type { MachinesService } from "@rakazo/adapters";

export interface MachineEgressUpgradeDeps {
  auth: Auth;
  prisma: PrismaClient;
  machines: MachinesService;
  egress: MachineEgressHub;
}

export function isMachineEgressUpgrade(request: IncomingMessage): boolean {
  const upgrade = request.headers.upgrade;
  return typeof upgrade === "string" && upgrade.toLowerCase() === MACHINE_EGRESS_UPGRADE;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

function requestFromUpgrade(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, headerValue(value));
  }
  const path = request.url ?? "/";
  return new Request(`http://machine-egress.invalid${path}`, { headers });
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}

function reject(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function switchProtocols(socket: Duplex) {
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${MACHINE_EGRESS_UPGRADE}\r\nConnection: Upgrade\r\n\r\n`,
  );
}

function socketPeer(socket: Duplex): EgressPeer {
  return {
    send(frame: EgressFrame) {
      if (!socket.destroyed) socket.write(Buffer.from(encodeEgressPacket(frame)));
    },
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
}

function bindAttachment(
  socket: Duplex,
  head: Buffer,
  attachment: { receive(frame: EgressFrame): void; dispose(): void },
) {
  const reader = createEgressFrameReader(
    (frame) => attachment.receive(frame),
    () => socket.destroy(),
  );
  if (head.length) reader.push(head);
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("close", () => attachment.dispose());
  socket.on("error", () => attachment.dispose());
}

export async function loadOfficeEgressSnapshot(
  prisma: PrismaClient,
  egress: MachineEgressHub | undefined,
  actor: { spaceId: string; userId: string },
): Promise<MachineEgressSnapshot> {
  const preference = await prisma.officeEgressPreference.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { enabled: true },
  });
  return mergeEgressSnapshot(
    { enabled: preference?.enabled ?? false },
    egress?.snapshot(actor) ?? {
      hostConnected: false,
      activeConnections: 0,
      sessionTotal: 0,
    },
  );
}

export async function handleMachineEgressUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: MachineEgressUpgradeDeps,
): Promise<boolean> {
  if (!isMachineEgressUpgrade(request)) return false;
  const url = new URL(request.url ?? "/", "http://machine-egress.invalid");
  if (url.pathname === "/api/machines/egress/host") {
    const incoming = requestFromUpgrade(request);
    const session = await deps.auth.api.getSession({ headers: sessionHeaders(incoming) });
    if (!session?.user) {
      reject(socket, 401, "Unauthorized");
      return true;
    }
    const actor = await requireMembership(
      deps.prisma,
      session.user.id,
      headerValue(request.headers["x-rakazo-space-id"]) || undefined,
    ).catch(() => null);
    if (!actor) {
      reject(socket, 403, "Forbidden");
      return true;
    }
    const snapshot = await loadOfficeEgressSnapshot(deps.prisma, deps.egress, actor);
    if (!snapshot.enabled) {
      reject(socket, 403, "Forbidden");
      return true;
    }
    switchProtocols(socket);
    const attachment = deps.egress.attachHost(actor, socketPeer(socket));
    bindAttachment(socket, head, attachment);
    return true;
  }
  if (url.pathname === "/api/machines/runner/egress") {
    const authz = headerValue(request.headers.authorization);
    const token = /^Bearer (\S+)$/i.exec(authz)?.[1];
    const machine = await deps.machines.authenticate(token);
    if (!machine || machine.status !== "paired") {
      reject(socket, 401, "Unauthorized");
      return true;
    }
    const snapshot = await loadOfficeEgressSnapshot(deps.prisma, deps.egress, {
      spaceId: machine.spaceId,
      userId: machine.userId,
    });
    if (!snapshot.enabled) {
      reject(socket, 403, "Forbidden");
      return true;
    }
    const attachment = deps.egress.attachClient(
      { spaceId: machine.spaceId, userId: machine.userId, machineId: machine.id },
      socketPeer(socket),
    );
    if (!attachment) {
      reject(socket, 409, "Conflict");
      return true;
    }
    switchProtocols(socket);
    bindAttachment(socket, head, attachment);
    return true;
  }
  return false;
}
