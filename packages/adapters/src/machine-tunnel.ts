import { createHash, randomBytes } from "node:crypto";
import {
  type Actor,
  isMachineSecretFormat,
  isMachineTunnelHeaderName,
  isMachineTunnelHeaderValue,
  isMachineTunnelMethod,
  isValidMachineTunnelPath,
  isValidMachineTunnelQuery,
  MACHINE_COMMAND_BODY_MAX_BYTES,
  MACHINE_COMMAND_TTL_MS,
  MACHINE_OFFLINE_AFTER_MS,
  MACHINE_PAIRING_PREFIX,
  MACHINE_PAIRING_TTL_MS,
  MACHINE_POLL_INTERVAL_MS,
  MACHINE_POLL_WAIT_MS_MAX,
  MACHINE_RESULT_BODY_MAX_BYTES,
  MACHINE_TOKEN_PREFIX,
  type Machine,
  type MachineCommandRecord,
  type MachineCommandResult,
  type MachineCommandScope,
  type MachineRecord,
  type MachineStore,
  machineBase64ByteLength,
} from "@rakazo/contracts";

export type { MachineRecord, MachineStore };

export class MachineTunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineTunnelError";
  }
}

export class MachinePairingError extends MachineTunnelError {}
export class MachineAuthError extends MachineTunnelError {}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashMachineSecret(secret: string): string {
  return sha256Hex(secret);
}

export function generatePairingCode(): string {
  return MACHINE_PAIRING_PREFIX + randomBytes(32).toString("base64url");
}

function generateMachineToken(): string {
  return MACHINE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function machineStatusOf(
  record: Pick<MachineRecord, "status" | "lastSeenAt">,
  now: Date,
  offlineAfterMs = MACHINE_OFFLINE_AFTER_MS,
): Machine["status"] {
  if (record.status === "revoked") return "revoked";
  if (record.status === "pending") return "pending";
  if (record.lastSeenAt && now.getTime() - record.lastSeenAt.getTime() <= offlineAfterMs) {
    return "online";
  }
  return "offline";
}

export function toMachineDto(record: MachineRecord, now: Date): Machine {
  return {
    id: record.id,
    name: record.name,
    status: machineStatusOf(record, now),
    version: record.version,
    lastSeenAt: record.lastSeenAt ? record.lastSeenAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface MachinesServiceLimits {
  pairingTtlMs?: number;
  commandTtlMs?: number;
  pollWaitMsMax?: number;
  commandBodyMaxBytes?: number;
  resultBodyMaxBytes?: number;
}

export interface EnqueueMachineRequest {
  machineId: string;
  method: string;
  path: string;
  query?: string;
  /** Raw request body; encoded to base64 exactly once here. */
  body?: Uint8Array | string | null;
  /** Pre-encoded body (already base64); takes precedence over body. */
  bodyBase64?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
  scope?: MachineCommandScope;
}

export interface MachinesService {
  list(actor: Actor): Promise<Machine[]>;
  startPairing(
    actor: Actor,
    input: { name: string },
  ): Promise<{ pairingId: string; code: string; expiresAt: Date }>;
  cancelPairing(actor: Actor, input: { pairingId: string }): Promise<void>;
  revoke(actor: Actor, input: { machineId: string }): Promise<void>;
  remove(actor: Actor, input: { machineId: string }): Promise<void>;
  pair(input: { code: string; name?: string; version?: string }): Promise<{
    machineId: string;
    token: string;
  }>;
  authenticate(token: string | null | undefined): Promise<MachineRecord | null>;
  poll(input: {
    machineId: string;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<MachineCommandRecord | null>;
  complete(input: {
    machineId: string;
    commandId: string;
    response: MachineCommandResult;
  }): Promise<"accepted" | "already" | "missing" | "aborted">;
  heartbeat(input: { machineId: string; version?: string }): Promise<void>;
  enqueue(request: EnqueueMachineRequest): Promise<MachineCommandRecord>;
  waitForCommand(input: {
    machineId: string;
    commandId: string;
    signal?: AbortSignal;
  }): Promise<MachineCommandRecord>;
  tombstone(input: { machineId: string; commandId: string }): Promise<boolean>;
  status(record: MachineRecord): Machine["status"];
}

export interface MachinesServiceOptions {
  store: MachineStore;
  now?: () => Date;
  limits?: MachinesServiceLimits;
}

function assertActorScope(actor: Actor, record: MachineRecord): void {
  if (record.spaceId !== actor.spaceId || record.userId !== actor.userId) {
    throw new MachineTunnelError("Machine not found");
  }
}

export function createMachinesService({
  store,
  now = () => new Date(),
  limits = {},
}: MachinesServiceOptions): MachinesService {
  const pairingTtlMs = limits.pairingTtlMs ?? MACHINE_PAIRING_TTL_MS;
  const commandTtlMs = limits.commandTtlMs ?? MACHINE_COMMAND_TTL_MS;
  const pollWaitMsMax = limits.pollWaitMsMax ?? MACHINE_POLL_WAIT_MS_MAX;
  const commandBodyMaxBytes = limits.commandBodyMaxBytes ?? MACHINE_COMMAND_BODY_MAX_BYTES;
  const resultBodyMaxBytes = limits.resultBodyMaxBytes ?? MACHINE_RESULT_BODY_MAX_BYTES;

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        },
        { once: true },
      );
    });

  const service: MachinesService = {
    async list(actor) {
      const records = await store.listMachines(actor.spaceId, actor.userId);
      const stamp = now();
      return records.map((record) => toMachineDto(record, stamp));
    },

    async startPairing(actor, input) {
      const code = generatePairingCode();
      const stamp = now();
      const record = await store.createMachine({
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: input.name,
        pairingCodeHash: sha256Hex(code),
        pairingExpiresAt: new Date(stamp.getTime() + pairingTtlMs),
        now: stamp,
      });
      return { pairingId: record.id, code, expiresAt: record.pairingExpiresAt ?? stamp };
    },

    async cancelPairing(actor, input) {
      const record = await store.getMachine(actor.spaceId, actor.userId, input.pairingId);
      if (!record) throw new MachineTunnelError("Machine not found");
      assertActorScope(actor, record);
      if (record.status !== "pending") throw new MachinePairingError("Pairing already completed");
      await store.deleteMachine(record.id);
    },

    async revoke(actor, input) {
      const record = await store.getMachine(actor.spaceId, actor.userId, input.machineId);
      if (!record) throw new MachineTunnelError("Machine not found");
      assertActorScope(actor, record);
      // Atomic credential clear + tombstone of all in-flight commands: a
      // revoked machine can never claim, and queued work never executes later.
      await store.revokeMachine(record.id);
    },

    async remove(actor, input) {
      const record = await store.getMachine(actor.spaceId, actor.userId, input.machineId);
      if (!record) throw new MachineTunnelError("Machine not found");
      assertActorScope(actor, record);
      await store.revokeMachine(record.id);
      await store.deleteMachine(record.id);
    },

    async pair(input) {
      if (!isMachineSecretFormat(input.code)) throw new MachinePairingError("Invalid pairing code");
      const record = await store.findMachineByPairingHash(sha256Hex(input.code));
      if (!record) throw new MachinePairingError("Invalid pairing code");
      if (record.status !== "pending") throw new MachinePairingError("Pairing already used");
      const stamp = now();
      if (!record.pairingExpiresAt || record.pairingExpiresAt.getTime() <= stamp.getTime()) {
        throw new MachinePairingError("Pairing code expired");
      }
      const token = generateMachineToken();
      const claimed = await store.claimPairing(record.id, sha256Hex(input.code), {
        credentialHash: sha256Hex(token),
        name: input.name,
        version: input.version ?? null,
        now: stamp,
      });
      if (!claimed) throw new MachinePairingError("Pairing already used");
      return { machineId: record.id, token };
    },

    async authenticate(token) {
      if (!token || !isMachineSecretFormat(token)) return null;
      const record = await store.findMachineByCredentialHash(sha256Hex(token));
      if (!record || record.status !== "paired" || !record.credentialHash) return null;
      return record;
    },

    async poll(input) {
      const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, pollWaitMsMax));
      const deadline = now().getTime() + waitMs;
      while (true) {
        const command = await store.claimNextCommand(input.machineId, now());
        if (command) return command;
        if (now().getTime() >= deadline) return null;
        await sleep(Math.min(MACHINE_POLL_INTERVAL_MS, deadline - now().getTime()), input.signal);
      }
    },

    async complete(input) {
      const { status } = input.response;
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new MachineTunnelError("Invalid result status");
      }
      if (input.response.bodyBase64 != null) {
        const bytes = machineBase64ByteLength(input.response.bodyBase64);
        if (bytes === null) throw new MachineTunnelError("Invalid result base64");
        if (bytes > resultBodyMaxBytes)
          throw new MachineTunnelError("Runner result exceeds transport bound");
      }
      if (
        input.response.contentType != null &&
        (input.response.contentType.length > 256 || /[^\x20-\x7e]/.test(input.response.contentType))
      ) {
        throw new MachineTunnelError("Invalid result content type");
      }
      return store.completeCommand(input.machineId, input.commandId, input.response, now());
    },

    async heartbeat(input) {
      await store.updateMachine(input.machineId, {
        lastSeenAt: now(),
        ...(input.version ? { version: input.version } : {}),
      });
    },

    async enqueue(request) {
      if (!isMachineTunnelMethod(request.method)) {
        throw new MachineTunnelError(`Tunnel method not allowed: ${request.method}`);
      }
      if (!isValidMachineTunnelPath(request.path)) {
        throw new MachineTunnelError("Tunnel destination path not allowed");
      }
      const query = request.query ?? "";
      if (!isValidMachineTunnelQuery(query)) {
        throw new MachineTunnelError("Tunnel destination query not allowed");
      }
      let bodyBase64: string | null = null;
      if (request.bodyBase64 != null) {
        const bytes = machineBase64ByteLength(request.bodyBase64);
        if (bytes === null) throw new MachineTunnelError("Invalid request base64");
        if (bytes > commandBodyMaxBytes) {
          throw new MachineTunnelError(
            `Tunnel request body exceeds the ${commandBodyMaxBytes} byte bound`,
          );
        }
        bodyBase64 = request.bodyBase64;
      } else if (request.body != null) {
        const bytes =
          typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body;
        if (bytes.byteLength > commandBodyMaxBytes) {
          throw new MachineTunnelError(
            `Tunnel request body of ${bytes.byteLength} bytes exceeds the ${commandBodyMaxBytes} byte bound`,
          );
        }
        bodyBase64 = Buffer.from(bytes).toString("base64");
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!isMachineTunnelHeaderName(name)) continue;
        if (!isMachineTunnelHeaderValue(value)) continue;
        headers[name.toLowerCase()] = value;
      }
      const stamp = now();
      return store.createCommand({
        machineId: request.machineId,
        method: request.method,
        path: request.path,
        query,
        bodyBase64,
        contentType: request.contentType ?? headers["content-type"] ?? null,
        headersJson: JSON.stringify(headers),
        scope: request.scope ?? { kind: "unscoped" },
        expiresAt: new Date(stamp.getTime() + commandTtlMs),
        now: stamp,
      });
    },

    async waitForCommand(input) {
      const deadlineMs = MACHINE_POLL_INTERVAL_MS;
      while (true) {
        const record = await store.getCommand(input.machineId, input.commandId);
        if (!record) throw new MachineTunnelError("Machine command not found");
        const stale = record.expiresAt.getTime() <= now().getTime();
        if (stale || (record.status !== "pending" && record.status !== "claimed")) return record;
        await sleep(deadlineMs, input.signal);
      }
    },

    async tombstone(input) {
      return store.tombstoneCommand(input.machineId, input.commandId);
    },

    status(record) {
      return machineStatusOf(record, now());
    },
  };
  return service;
}

export interface MachineFetchOptions {
  /**
   * Map a validated tunnel request to its durable scope for claim-time proof.
   * Production composition MUST provide one: without it the fetch refuses to
   * enqueue (fail closed) rather than issuing unscoped commands.
   */
  scopeResolver?: (info: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
  }) => Promise<MachineCommandScope> | MachineCommandScope;
  /** Test-only escape hatch; production composition never sets this. */
  allowUnscoped?: boolean;
}

/**
 * A fetch-compatible tunnel client: every call becomes exactly one durable
 * machine command. The URL authority is ignored on purpose — only the path and
 * query are forwarded, validated against the supervisor allowlist — so a run
 * can never point the tunnel at an arbitrary server.
 */
export function createMachineFetch(
  service: MachinesService,
  machineId: string,
  options: MachineFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = new URL(String(request?.url ?? input), "https://machine-tunnel.invalid");
    const path = url.pathname;
    const query = url.search.startsWith("?") ? url.search.slice(1) : "";
    const merged = new Headers(init?.headers ?? request?.headers ?? undefined);
    const headers: Record<string, string> = {};
    merged.forEach((value, name) => {
      headers[name] = value;
    });
    const contentType = merged.get("content-type");
    let body: string | null = null;
    const rawBody = init?.body ?? request?.body ?? null;
    if (rawBody != null) {
      if (typeof rawBody === "string") {
        body = Buffer.from(rawBody, "utf8").toString("base64");
      } else if (rawBody instanceof ArrayBuffer) {
        body = Buffer.from(rawBody).toString("base64");
      } else if (ArrayBuffer.isView(rawBody)) {
        body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString(
          "base64",
        );
      } else {
        throw new MachineTunnelError("Unsupported tunnel request body type");
      }
    }
    if (!options.scopeResolver && !options.allowUnscoped) {
      throw new MachineTunnelError(
        "Machine tunnel requires a scope resolver; unscoped commands are refused in production",
      );
    }
    const scope = options.scopeResolver
      ? await options.scopeResolver({ method, path, query, headers })
      : ({ kind: "unscoped" } as MachineCommandScope);
    if (scope.kind === "unscoped" && !options.allowUnscoped) {
      throw new MachineTunnelError("Tunnel request has no verifiable machine scope");
    }
    const command = await service.enqueue({
      machineId,
      method,
      path,
      query,
      bodyBase64: body,
      contentType,
      headers,
      scope,
    });
    const signal = init?.signal ?? request?.signal ?? undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal) {
        onAbort = () => {
          void service.tombstone({ machineId, commandId: command.id }).catch(() => undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        signal.throwIfAborted();
      }
      const result = await service.waitForCommand({ machineId, commandId: command.id, signal });
      if (result.status === "completed" && result.responseStatus != null) {
        const responseHeaders = new Headers();
        if (result.responseContentType) {
          responseHeaders.set("content-type", result.responseContentType);
        }
        if (
          result.responseStatus === 204 ||
          result.responseStatus === 304 ||
          result.responseBodyBase64 == null
        ) {
          return new Response(null, { status: result.responseStatus, headers: responseHeaders });
        }
        const bytes = Buffer.from(result.responseBodyBase64, "base64");
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return new Response(copy, { status: result.responseStatus, headers: responseHeaders });
      }
      throw new MachineTunnelError(`Machine command ${result.status}`);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}
