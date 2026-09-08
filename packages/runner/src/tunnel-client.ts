import { MACHINE_POLL_RESPONSE_MAX_BYTES, MACHINE_POLL_WAIT_MS_MAX } from "@rakazo/contracts";
import { readBoundedResponseBytes } from "@rakazo/core";

export { MACHINE_POLL_WAIT_MS_MAX };

export const RUNNER_VERSION = "0.1.0";
/** A command body's base64 plus a small JSON envelope fits one poll response. */
const MAX_POLL_RESPONSE_BYTES = MACHINE_POLL_RESPONSE_MAX_BYTES;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

export interface MachineCommand {
  id: string;
  method: string;
  path: string;
  query?: string;
  bodyBase64?: string | null;
  contentType?: string | null;
  /** JSON object of allowlisted passthrough headers (lease context, screen ids). */
  headersJson?: string;
  headers?: Record<string, string>;
  createdAt?: string;
  expiresAt?: string;
}

export interface PairResult {
  machineId: string;
  token: string;
}

export class MachineRevokedError extends Error {
  constructor(message = "This machine token was revoked or is unknown to the server") {
    super(message);
  }
}

export interface TunnelClientOptions {
  serverUrl: string;
  fetch?: typeof fetch;
}

interface RunnerEndpoint {
  path: string;
  body: unknown;
  maxResponseBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export class TunnelClient {
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(options: TunnelClientOptions) {
    this.base = options.serverUrl.replace(/\/$/, "");
    this.http = options.fetch ?? fetch;
  }

  private async request(
    token: string | undefined,
    endpoint: RunnerEndpoint,
  ): Promise<{ status: number; body: Uint8Array }> {
    const timeout = AbortSignal.timeout(endpoint.timeoutMs);
    const signal = endpoint.signal ? AbortSignal.any([endpoint.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await this.http(`${this.base}${endpoint.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(endpoint.body),
      redirect: "error",
      signal,
    });
    const body = await readBoundedResponseBytes(response, {
      maxBytes: endpoint.maxResponseBytes,
      tooLargeMessage: "Runner response exceeds limit",
      read: (operation) => {
        signal.throwIfAborted();
        return operation();
      },
    });
    return { status: response.status, body };
  }

  private async requestJson<T>(
    token: string | undefined,
    endpoint: RunnerEndpoint,
  ): Promise<{ status: number; payload: T }> {
    const { status, body } = await this.request(token, endpoint);
    const text = new TextDecoder().decode(body);
    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch {
      throw new Error(`Runner endpoint ${endpoint.path} returned invalid JSON (${status})`);
    }
    return { status, payload };
  }

  private static checkAuthStatus(status: number, path: string) {
    if (status === 401) throw new MachineRevokedError();
    if (status === 404 || status === 409 || status === 410) {
      throw new Error(`Runner endpoint ${path} rejected the update (${status})`);
    }
    if (status === 413) throw new Error(`Runner endpoint ${path} rejected the body size (413)`);
    if (status < 200 || status >= 300) {
      throw new Error(`Runner endpoint ${path} failed (${status})`);
    }
  }

  static async pair(
    serverUrl: string,
    options: { code: string; name?: string; version?: string; fetch?: typeof fetch },
  ): Promise<PairResult> {
    const client = new TunnelClient({ serverUrl, fetch: options.fetch });
    const { status, payload } = await client.requestJson<{ machineId?: string; token?: string }>(
      undefined,
      {
        path: "/api/machines/runner/pair",
        body: {
          code: options.code,
          ...(options.name ? { name: options.name } : {}),
          version: options.version ?? RUNNER_VERSION,
        },
        maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
        timeoutMs: 15_000,
      },
    );
    if (status === 401) throw new Error("Pairing code is invalid");
    if (status === 410) throw new Error("Pairing code expired or was already used");
    if (status < 200 || status >= 300) throw new Error(`Pairing failed (${status})`);
    if (typeof payload.machineId !== "string" || typeof payload.token !== "string") {
      throw new Error("Pairing response is missing credentials");
    }
    return { machineId: payload.machineId, token: payload.token };
  }

  async poll(
    machineToken: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<MachineCommand | null> {
    const { status, payload } = await this.requestJson<{ command?: MachineCommand | null }>(
      machineToken,
      {
        path: "/api/machines/runner/poll",
        signal,
        body: { waitMs: Math.max(0, Math.min(MACHINE_POLL_WAIT_MS_MAX, Math.round(waitMs))) },
        maxResponseBytes: MAX_POLL_RESPONSE_BYTES,
        timeoutMs: (waitMs > 0 ? waitMs : 0) + 30_000,
      },
    );
    TunnelClient.checkAuthStatus(status, "/api/machines/runner/poll");
    return payload.command ?? null;
  }

  async postResult(
    machineToken: string,
    commandId: string,
    result: { status: number; statusText?: string; bodyBase64?: string; contentType?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const { status } = await this.request(machineToken, {
      path: `/api/machines/runner/commands/${encodeURIComponent(commandId)}/result`,
      signal,
      body: {
        status: result.status,
        ...(result.statusText ? { statusText: result.statusText.slice(0, 300) } : {}),
        ...(result.bodyBase64 === undefined ? {} : { bodyBase64: result.bodyBase64 }),
        ...(result.contentType ? { contentType: result.contentType } : {}),
      },
      maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
      timeoutMs: 30_000,
    });
    // 404/409 mean the server already expired or completed the command; the caller sees
    // tunnel failure on its side either way, so this must not crash the runner loop.
    if (status === 401) throw new MachineRevokedError();
    if (status !== 200 && status !== 404 && status !== 409) {
      throw new Error(`Posting command result failed (${status})`);
    }
  }

  async heartbeat(machineToken: string, signal?: AbortSignal): Promise<void> {
    const { status } = await this.request(machineToken, {
      path: "/api/machines/runner/heartbeat",
      signal,
      body: { version: RUNNER_VERSION },
      maxResponseBytes: MAX_CONTROL_RESPONSE_BYTES,
      timeoutMs: 15_000,
    });
    TunnelClient.checkAuthStatus(status, "/api/machines/runner/heartbeat");
  }
}
