import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

// Machine pairing codes and runner credentials share one secret shape. The
// server stores only sha256 digests; the plaintext is shown/pasted exactly once.
export const MACHINE_PAIRING_PREFIX = "rk_p_";
export const MACHINE_TOKEN_PREFIX = "rk_m_";
export const MACHINE_SECRET_LENGTH = 43; // 32 random bytes, base64url

export function isMachineSecretFormat(secret: string): boolean {
  for (const prefix of [MACHINE_PAIRING_PREFIX, MACHINE_TOKEN_PREFIX]) {
    if (secret.startsWith(prefix)) {
      const rest = secret.slice(prefix.length);
      return rest.length === MACHINE_SECRET_LENGTH && /^[A-Za-z0-9_-]+$/.test(rest);
    }
  }
  return false;
}

// Transport bounds. Pi RPC frames are up to 16 MiB and the supervisor host reads
// event batches of up to 2x that, so tunnel bodies are bounded above the frame
// ceiling — requests are never truncated; oversize is an actionable error.
export const MACHINE_PAIRING_TTL_MS = 10 * 60_000;
export const MACHINE_OFFLINE_AFTER_MS = 90_000;
export const MACHINE_COMMAND_TTL_MS = 90_000;
export const MACHINE_POLL_WAIT_MS_MAX = 20_000;
export const MACHINE_POLL_INTERVAL_MS = 200;
export const MACHINE_COMMAND_BODY_MAX_BYTES = 32 * 1024 * 1024;
export const MACHINE_RESULT_BODY_MAX_BYTES = 64 * 1024 * 1024;
// HTTP JSON envelopes carry base64; payload constants above count decoded bytes.
export const MACHINE_POLL_RESPONSE_MAX_BYTES =
  Math.ceil(MACHINE_COMMAND_BODY_MAX_BYTES / 3) * 4 + 64 * 1024;
export const MACHINE_RESULT_REQUEST_MAX_BYTES =
  Math.ceil(MACHINE_RESULT_BODY_MAX_BYTES / 3) * 4 + 64 * 1024;

/** Validate canonical base64 and compute size before allocating a decoded body. */
export function machineBase64ByteLength(value: string): number | null {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && firstPadding !== value.length - padding) return null;
  if (padding) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(value[value.length - padding - 1] ?? "=");
    if (last < 0 || (last & (padding === 2 ? 15 : 3)) !== 0) return null;
  }
  return (value.length / 4) * 3 - padding;
}

export const MACHINE_TUNNEL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type MachineTunnelMethod = (typeof MACHINE_TUNNEL_METHODS)[number];

export function isMachineTunnelMethod(method: string): method is MachineTunnelMethod {
  return (MACHINE_TUNNEL_METHODS as readonly string[]).includes(method);
}

/** Only the existing isolated Pi supervisor (/agents) and computer containers (/computers) trees. */
export function isValidMachineTunnelPath(path: string): boolean {
  if (path.length === 0 || path.length > 2048) return false;
  if (path.includes("..") || path.includes("//") || path.includes("%")) return false;
  if (!path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9._~-]{1,200}$/.test(segment))) return false;
  return segments[0] === "agents" || segments[0] === "computers";
}

function hasValidPercentEscapes(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return false;
  }
  return true;
}

export function isValidMachineTunnelQuery(query: string): boolean {
  if (query.length > 2048) return false;
  if (query === "") return true;
  if (!hasValidPercentEscapes(query)) return false;
  return /^(?:[A-Za-z0-9._~-]+(?:=[A-Za-z0-9._~%-]*)?)(?:&(?:[A-Za-z0-9._~-]+(?:=[A-Za-z0-9._~%-]*)?))*$/.test(
    query,
  );
}

/** The runner substitutes its own local supervisor authorization; auth never traverses the tunnel. */
export function isMachineTunnelHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "content-type" || /^x-rakazo-[a-z-]+$/.test(normalized);
}

export function isMachineTunnelHeaderValue(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9._:-]*$/.test(value);
}

export const MachineStatus = z.enum(["pending", "online", "offline", "revoked"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

export const MachineSchema = z.object({
  id: Id,
  name: z.string(),
  status: MachineStatus,
  version: z.string().nullable(),
  lastSeenAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type Machine = z.infer<typeof MachineSchema>;

export const MachinePairingSchema = z.object({
  pairingId: Id,
  code: z.string(),
  expiresAt: IsoDate,
});
export type MachinePairing = z.infer<typeof MachinePairingSchema>;

export const MachineAssignmentSchema = z.object({
  botId: Id,
  machineId: z.string().nullable(),
  computerId: z.string().nullable(),
});
export type MachineAssignment = z.infer<typeof MachineAssignmentSchema>;

/**
 * Durable identity of the run/computer a tunnel command is allowed to touch,
 * captured from the request (not re-read at claim time) so the claim and the
 * result acceptance can verify the run lease has not moved on: lease fencing
 * prevents zombie commands after the same run id changes owners.
 */
export type MachineCommandScope =
  | {
      kind: "agent";
      spaceId: string;
      runId: string;
      botId: string;
      leaseOwner: string;
      leaseFence: number;
    }
  | {
      kind: "computer";
      spaceId: string;
      computerId: string;
      /** Present when the command runs under a run lease; lease-less user maintenance omits it. */
      runId?: string;
      leaseOwner?: string;
      leaseFence?: number;
    }
  | { kind: "unscoped" };

export type MachineRecordStatus = "pending" | "paired" | "revoked";

export interface MachineRecord {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  status: MachineRecordStatus;
  pairingCodeHash: string | null;
  pairingExpiresAt: Date | null;
  credentialHash: string | null;
  lastSeenAt: Date | null;
  version: string | null;
  createdAt: Date;
}

export type MachineCommandStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "expired"
  | "failed"
  | "aborted";

export interface MachineCommandRecord {
  id: string;
  machineId: string;
  method: string;
  path: string;
  query: string;
  bodyBase64: string | null;
  contentType: string | null;
  /** JSON object of allowlisted passthrough headers (never authorization). */
  headersJson: string;
  scopeKind: MachineCommandScope["kind"];
  scopeSpaceId: string | null;
  scopeRunId: string | null;
  scopeBotId: string | null;
  scopeComputerId: string | null;
  scopeLeaseOwner: string | null;
  scopeLeaseFence: number | null;
  status: MachineCommandStatus;
  responseStatus: number | null;
  responseContentType: string | null;
  responseBodyBase64: string | null;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
}

export interface MachineCommandResult {
  status: number;
  contentType: string | null;
  bodyBase64: string | null;
}

/**
 * The single persistence seam between the server tunnel (adapters) and the
 * durable mailbox (db). Implementations must serialize claims against
 * revocation and scope so a revoked machine or stale scope never receives —
 * and a timed-out caller can never later trigger — a command.
 */
export interface MachineStore {
  createMachine(input: {
    spaceId: string;
    userId: string;
    name: string;
    pairingCodeHash: string;
    pairingExpiresAt: Date;
    now: Date;
  }): Promise<MachineRecord>;
  listMachines(spaceId: string, userId: string): Promise<MachineRecord[]>;
  getMachine(spaceId: string, userId: string, machineId: string): Promise<MachineRecord | null>;
  getMachineById(machineId: string): Promise<MachineRecord | null>;
  updateMachine(
    machineId: string,
    patch: {
      name?: string;
      version?: string | null;
      lastSeenAt?: Date | null;
      status?: MachineRecordStatus;
      credentialHash?: string | null;
      pairingCodeHash?: string | null;
      pairingExpiresAt?: Date | null;
    },
  ): Promise<void>;
  deleteMachine(machineId: string): Promise<void>;
  findMachineByPairingHash(hash: string): Promise<MachineRecord | null>;
  findMachineByCredentialHash(hash: string): Promise<MachineRecord | null>;
  /** Single-use pairing: only wins when the row is still pending with this exact hash. */
  claimPairing(
    machineId: string,
    pairingCodeHash: string,
    patch: { credentialHash: string; name?: string; version?: string | null; now: Date },
  ): Promise<boolean>;
  /** Atomically clear the credential AND tombstone every pending/claimed command. */
  revokeMachine(machineId: string): Promise<void>;
  createCommand(input: {
    machineId: string;
    method: string;
    path: string;
    query: string;
    bodyBase64: string | null;
    contentType: string | null;
    headersJson: string;
    scope: MachineCommandScope;
    expiresAt: Date;
    now: Date;
  }): Promise<MachineCommandRecord>;
  getCommand(machineId: string, commandId: string): Promise<MachineCommandRecord | null>;
  /**
   * Atomically hand out the next pending command at most once, proving the
   * machine credential is active AND the command's scope still resolves to
   * this machine (paired run on an assigned computer / computer still bound).
   * Expired pending/claimed commands are swept first.
   */
  claimNextCommand(machineId: string, now: Date): Promise<MachineCommandRecord | null>;
  completeCommand(
    machineId: string,
    commandId: string,
    response: MachineCommandResult,
    now: Date,
  ): Promise<"accepted" | "already" | "missing" | "aborted">;
  /** Stop a pending or claimed command from executing/being delivered after the caller gave up. */
  tombstoneCommand(machineId: string, commandId: string): Promise<boolean>;
  expireMachineCommands(machineId: string, now: Date): Promise<void>;
}
