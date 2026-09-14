import {
  MACHINE_EGRESS_MAX_FRAME_BYTES,
  MACHINE_EGRESS_MAX_HOST_LENGTH,
  MACHINE_EGRESS_MAX_STREAMS,
  MACHINE_EGRESS_PROXY_HOST,
  MACHINE_EGRESS_PROXY_PORT,
} from "@rakazo/contracts";

export const EGRESS_FRAME_OPEN = 1;
export const EGRESS_FRAME_DATA = 2;
export const EGRESS_FRAME_CLOSE = 3;
export const EGRESS_FRAME_READY = 4;

export type EgressTarget = { host: string; port: number };

export type EgressFrame =
  | { type: "open"; id: number; host: string; port: number }
  | { type: "data"; id: number; bytes: Uint8Array }
  | { type: "close"; id: number; error?: string }
  | { type: "ready"; id: number };

export function officeEgressProxyUrl(port = MACHINE_EGRESS_PROXY_PORT): string {
  return `http://${MACHINE_EGRESS_PROXY_HOST}:${port}`;
}

/** CONNECT host[:port] or [ipv6]:port. Missing port is 443. */
export function parseEgressTarget(value: string): EgressTarget | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MACHINE_EGRESS_MAX_HOST_LENGTH + 6) return null;
  if (/[\s\0/\\]/.test(trimmed) || trimmed.includes("@")) return null;

  let host: string;
  let portText: string;
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close < 2) return null;
    host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (rest === "") portText = "443";
    else if (rest.startsWith(":") && rest.length > 1) portText = rest.slice(1);
    else return null;
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon === -1) {
      host = trimmed;
      portText = "443";
    } else {
      host = trimmed.slice(0, colon);
      portText = trimmed.slice(colon + 1);
    }
  }
  if (!isEgressHost(host)) return null;
  if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

function isEgressHost(host: string): boolean {
  if (host.length === 0 || host.length > MACHINE_EGRESS_MAX_HOST_LENGTH) return false;
  if (host === "localhost") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((octet) => {
      const value = Number(octet);
      return octet === String(value) && value >= 0 && value <= 255;
    });
  }
  if (host.includes(":")) {
    return /^[0-9A-Fa-f:]+$/.test(host) && host.split(":").length >= 3;
  }
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    host,
  );
}

export function encodeEgressFrame(frame: EgressFrame): Uint8Array {
  if (frame.type === "open") {
    const host = new TextEncoder().encode(frame.host);
    if (host.length > MACHINE_EGRESS_MAX_HOST_LENGTH) {
      throw new RangeError("Egress host exceeds the frame bound");
    }
    const bytes = new Uint8Array(8 + host.length);
    bytes[0] = EGRESS_FRAME_OPEN;
    writeU32(bytes, 1, frame.id);
    writeU16(bytes, 5, frame.port);
    bytes[7] = host.length;
    bytes.set(host, 8);
    return bytes;
  }
  if (frame.type === "data") {
    const bytes = new Uint8Array(9 + frame.bytes.length);
    bytes[0] = EGRESS_FRAME_DATA;
    writeU32(bytes, 1, frame.id);
    writeU32(bytes, 5, frame.bytes.length);
    bytes.set(frame.bytes, 9);
    return bytes;
  }
  if (frame.type === "ready") {
    const bytes = new Uint8Array(5);
    bytes[0] = EGRESS_FRAME_READY;
    writeU32(bytes, 1, frame.id);
    return bytes;
  }
  const message = new TextEncoder().encode(frame.error ?? "");
  const bytes = new Uint8Array(7 + message.length);
  bytes[0] = EGRESS_FRAME_CLOSE;
  writeU32(bytes, 1, frame.id);
  writeU16(bytes, 5, message.length);
  bytes.set(message, 7);
  return bytes;
}

export function decodeEgressFrame(bytes: Uint8Array): EgressFrame | null {
  if (bytes.length < 5) return null;
  const type = bytes[0];
  const id = readU32(bytes, 1);
  if (!Number.isInteger(id) || id < 1) return null;
  if (type === EGRESS_FRAME_OPEN) {
    if (bytes.length < 8) return null;
    const port = readU16(bytes, 5);
    const hostLen = bytes[7] ?? 0;
    if (bytes.length !== 8 + hostLen) return null;
    const host = new TextDecoder().decode(bytes.subarray(8));
    const target = parseEgressTarget(`${host.includes(":") ? `[${host}]` : host}:${port}`);
    if (!target) return null;
    return { type: "open", id, host: target.host, port: target.port };
  }
  if (type === EGRESS_FRAME_DATA) {
    if (bytes.length < 9) return null;
    const length = readU32(bytes, 5);
    if (bytes.length !== 9 + length) return null;
    return { type: "data", id, bytes: bytes.subarray(9) };
  }
  if (type === EGRESS_FRAME_READY) {
    if (bytes.length !== 5) return null;
    return { type: "ready", id };
  }
  if (type === EGRESS_FRAME_CLOSE) {
    if (bytes.length < 7) return null;
    const length = readU16(bytes, 5);
    if (bytes.length !== 7 + length) return null;
    const error = length === 0 ? undefined : new TextDecoder().decode(bytes.subarray(7));
    return { type: "close", id, ...(error ? { error } : {}) };
  }
  return null;
}

export function createEgressFrameReader(
  onFrame: (frame: EgressFrame) => void,
  onError: (error: Error) => void,
  maxBytes = MACHINE_EGRESS_MAX_FRAME_BYTES,
): { push(chunk: Uint8Array): void } {
  let buffer = new Uint8Array(0);
  return {
    push(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      const next = new Uint8Array(buffer.length + chunk.length);
      next.set(buffer);
      next.set(chunk, buffer.length);
      buffer = next;
      while (buffer.length >= 4) {
        const size = readU32(buffer, 0);
        if (size < 5 || size > maxBytes) {
          onError(new Error("Egress frame exceeds the transport bound"));
          buffer = new Uint8Array(0);
          return;
        }
        if (buffer.length < 4 + size) return;
        const encoded = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        const frame = decodeEgressFrame(encoded);
        if (!frame) {
          onError(new Error("Egress frame is invalid"));
          return;
        }
        onFrame(frame);
      }
    },
  };
}

export function encodeEgressPacket(frame: EgressFrame): Uint8Array {
  const payload = encodeEgressFrame(frame);
  if (payload.length > MACHINE_EGRESS_MAX_FRAME_BYTES) {
    throw new RangeError("Egress frame exceeds the transport bound");
  }
  const packet = new Uint8Array(4 + payload.length);
  writeU32(packet, 0, payload.length);
  packet.set(payload, 4);
  return packet;
}

export { MACHINE_EGRESS_MAX_STREAMS };

function writeU16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
