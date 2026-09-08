import { mkdir } from "node:fs/promises";
import { readBoundedResponseBytes } from "@rakazo/core";
import {
  CommandRejectedError,
  MAX_SUPERVISOR_RESPONSE_BYTES,
  validateCommand,
} from "./command-validation.js";

export interface SupervisorTarget {
  baseUrl: string;
  token: string;
  /** Directory the supervisor exposes as DATA_DIR; the runner shares this volume unprivileged. */
  dataDir: string;
  fetch?: typeof fetch;
}

export interface ForwardResult {
  status: number;
  body: Uint8Array;
  contentType?: string;
}

const HOME_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export class SupervisorUnreachableError extends Error {}

/**
 * The runner is the only home authority on its machine: the backend's absolute homePath
 * points at backend-local storage and is always ignored. Homes live under a fixed
 * <dataDir>/homes/<homeKey> root that the unprivileged runner (uid 1000) creates; a
 * root-owned supervisor must never create or chown a model-chosen path.
 */
export function machineHomePath(dataDir: string, homeKey: string): string {
  if (!HOME_KEY_PATTERN.test(homeKey) || homeKey.includes("..")) {
    throw new CommandRejectedError("Computer home key is not allowed");
  }
  return `${dataDir.replace(/\/$/, "")}/homes/${homeKey}`;
}

export async function ensureRunnerHome(dataDir: string, homeKey: string): Promise<string> {
  const home = machineHomePath(dataDir, homeKey);
  await mkdir(home, { recursive: true });
  return home;
}

/** Rewrite a provision command onto the machine's fixed home root before execution. */
export async function rewriteProvisionBody(
  target: SupervisorTarget,
  body: Uint8Array,
  contentType: string | undefined,
): Promise<{ body: Uint8Array; contentType: string }> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    throw new CommandRejectedError("Provision command body is not valid JSON");
  }
  const homeKey = parsed.botId;
  const spaceId = parsed.spaceId;
  if (typeof homeKey !== "string" || typeof spaceId !== "string" || !spaceId) {
    throw new CommandRejectedError("Provision command is missing computer identity");
  }
  const homePath = await ensureRunnerHome(target.dataDir, homeKey);
  const rewritten = JSON.stringify({ botId: homeKey, homePath, spaceId });
  return {
    body: new TextEncoder().encode(rewritten),
    contentType: contentType ?? "application/json",
  };
}

export async function forwardToSupervisor(
  target: SupervisorTarget,
  command: {
    method: string;
    path: string;
    query?: string;
    headers?: Record<string, string>;
    bodyBase64?: string | null;
    contentType?: string | null;
  },
  signal: AbortSignal,
): Promise<ForwardResult> {
  const validated = validateCommand(command);
  let body = validated.body;
  let contentType = validated.contentType;
  if (validated.method === "POST" && validated.path === "/computers") {
    if (!body) throw new CommandRejectedError("Provision command is missing its body");
    const rewritten = await rewriteProvisionBody(target, body, contentType);
    body = rewritten.body;
    contentType = rewritten.contentType;
  }
  const url = `${target.baseUrl.replace(/\/$/, "")}${validated.path}${validated.query ? `?${validated.query}` : ""}`;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(330_000)]);
  let response: Response;
  try {
    response = await (target.fetch ?? fetch)(url, {
      method: validated.method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(contentType ? { "content-type": contentType } : {}),
        ...validated.headers,
      },
      ...(body ? { body: Buffer.from(body) } : {}),
      redirect: "error",
      signal: timeout,
    });
  } catch (error) {
    // The command was claimed, so the server must hear back: never leave it hanging.
    throw new SupervisorUnreachableError(
      error instanceof Error
        ? `Local supervisor unreachable: ${error.message}`
        : "Local supervisor unreachable",
    );
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_SUPERVISOR_RESPONSE_BYTES,
    tooLargeMessage: "Supervisor response exceeds the tunnel result limit",
    read: (operation) => {
      timeout.throwIfAborted();
      return operation();
    },
  });
  return {
    status: response.status,
    body: bytes,
    ...(response.headers.get("content-type")
      ? { contentType: response.headers.get("content-type") as string }
      : {}),
  };
}
