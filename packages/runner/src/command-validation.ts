import {
  isMachineTunnelHeaderName,
  isMachineTunnelHeaderValue,
  isMachineTunnelMethod,
  isValidMachineTunnelPath,
  isValidMachineTunnelQuery,
  MACHINE_COMMAND_BODY_MAX_BYTES,
  MACHINE_COMMAND_TTL_MS,
  MACHINE_OFFLINE_AFTER_MS,
  MACHINE_POLL_RESPONSE_MAX_BYTES,
  MACHINE_POLL_WAIT_MS_MAX,
  MACHINE_RESULT_BODY_MAX_BYTES,
  machineBase64ByteLength,
} from "@rakazo/contracts";

export {
  MACHINE_COMMAND_BODY_MAX_BYTES,
  MACHINE_COMMAND_TTL_MS,
  MACHINE_OFFLINE_AFTER_MS,
  MACHINE_POLL_WAIT_MS_MAX,
  MACHINE_RESULT_BODY_MAX_BYTES,
};

export class CommandRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

/** Shared bounds count decoded HTTP bytes, not base64 characters. */
export const MAX_SUPERVISOR_RESPONSE_BYTES = MACHINE_RESULT_BODY_MAX_BYTES;
/** A command body's base64 plus a small JSON envelope fits the poll response. */
export const MAX_POLL_RESPONSE_BYTES = MACHINE_POLL_RESPONSE_MAX_BYTES;

export interface ValidatedCommand {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  contentType?: string;
}

function parseCommandHeaders(command: { headers?: Record<string, string>; headersJson?: string }) {
  if (command.headers !== undefined && command.headersJson !== undefined) {
    throw new CommandRejectedError("Command carries headers twice");
  }
  if (command.headersJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(command.headersJson);
    } catch {
      throw new CommandRejectedError("Command headersJson is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CommandRejectedError("Command headersJson must be an object");
    }
    return parsed as Record<string, string>;
  }
  return command.headers ?? {};
}

/**
 * Runner-side revalidation against the shared contracts validators: the model never
 * picks a destination, paths stay inside the fixed supervisor authority, and no
 * arbitrary URL or header is forwarded. The authorization header is never carried:
 * the runner substitutes its own local supervisor secret.
 */
export function validateCommand(command: {
  method: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  headersJson?: string;
  bodyBase64?: string | null;
  contentType?: string | null;
}): ValidatedCommand {
  const method = command.method.toUpperCase();
  if (!isMachineTunnelMethod(method)) {
    throw new CommandRejectedError(`Command method is not allowed: ${method}`);
  }
  if (!isValidMachineTunnelPath(command.path)) {
    throw new CommandRejectedError("Command path is outside the local supervisor authority");
  }
  if (!isValidMachineTunnelQuery(command.query ?? "")) {
    throw new CommandRejectedError("Command query is not allowed");
  }
  const headers: Record<string, string> = {};
  let headerContentType: string | undefined;
  for (const [name, value] of Object.entries(parseCommandHeaders(command))) {
    const lower = name.toLowerCase();
    if (lower === "authorization") continue;
    // content-type travels in the command's dedicated field; accept a free header
    // only as a fallback and never as a general passthrough.
    if (lower === "content-type") {
      if (headerContentType === undefined && /^[^\s]{1,200}$/.test(value)) {
        headerContentType = value;
      }
      continue;
    }
    if (!isMachineTunnelHeaderName(lower)) continue;
    if (!isMachineTunnelHeaderValue(value)) {
      throw new CommandRejectedError(`Command header ${name} is not allowed`);
    }
    headers[lower] = value;
  }
  let body: Uint8Array | undefined;
  if (command.bodyBase64 != null && command.bodyBase64 !== "") {
    const bytes = machineBase64ByteLength(command.bodyBase64);
    if (bytes === null) throw new CommandRejectedError("Command body is not valid base64");
    if (bytes > MACHINE_COMMAND_BODY_MAX_BYTES) {
      throw new CommandRejectedError("Command body exceeds the tunnel limit", 413);
    }
    body = Uint8Array.from(Buffer.from(command.bodyBase64, "base64"));
  }
  const contentType = command.contentType ?? headerContentType;
  return {
    method,
    path: command.path,
    query: command.query ?? "",
    headers,
    ...(body ? { body } : {}),
    ...(contentType ? { contentType } : {}),
  };
}
