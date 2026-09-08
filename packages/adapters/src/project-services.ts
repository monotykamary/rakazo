import type {
  AdapterContext,
  ComputerRef,
  ComputerServiceInfo,
  ComputerServicePreviewResponse,
  ComputerServicesCapability,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  isAllowedServicePort,
  isValidMachineTunnelPath,
  isValidServiceName,
  SERVICE_PORTS_MAX,
} from "@rakazo/contracts";

/**
 * Client for the supervisor's /computers/:id/services surface. The same fetch
 * transport that carries exec/screens carries service control: direct to the
 * local supervisor, or through the durable machine tunnel for paired machines.
 */
export interface SupervisorServiceTransport {
  fetch: typeof fetch;
  url(path: string): string;
  headers(context: AdapterContext, homeKey?: string): Record<string, string>;
}

const SERVICE_CONTROL_TIMEOUT_MS = 30_000;
const PREVIEW_TIMEOUT_MS = 20_000;
const PREVIEW_BODY_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_BODY_BASE64_MAX = Math.ceil(PREVIEW_BODY_MAX_BYTES / 3) * 4 + 4;

async function supervisorJson(
  transport: SupervisorServiceTransport,
  computer: ComputerRef,
  context: AdapterContext,
  init: { method: string; path: string; body?: unknown; timeoutMs: number },
): Promise<Response> {
  const response = await transport.fetch(transport.url(init.path), {
    method: init.method,
    headers: {
      ...transport.headers(context, computer.botId),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(init.timeoutMs)]),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`service request failed (${response.status}): ${detail}`);
  }
  return response;
}

function serviceInfoOf(value: unknown): ComputerServiceInfo {
  const record = (value ?? {}) as Record<string, unknown>;
  const rawStatus = typeof record.status === "string" ? record.status : "unknown";
  const status = (
    "running stopped exited fatal unknown".split(" ").includes(rawStatus) ? rawStatus : "unknown"
  ) as ComputerServiceInfo["status"];
  return {
    name: String(record.name ?? ""),
    status,
    pid: typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null,
    ports: Array.isArray(record.ports)
      ? record.ports.filter((port): port is number => typeof port === "number")
      : [],
    keepAlive: record.keepAlive === true,
    cwd: String(record.cwd ?? ""),
    revision:
      typeof record.revision === "string" && record.revision.length <= 64
        ? record.revision
        : undefined,
  };
}

function validateSpec(spec: { name: string; argv: string[]; ports: number[] }): void {
  if (!isValidServiceName(spec.name)) throw new Error(`Invalid service name: ${spec.name}`);
  for (const port of spec.ports) {
    if (!isAllowedServicePort(port)) {
      throw new Error(`Service port out of range: ${String(port)}`);
    }
  }
  if (spec.ports.length > SERVICE_PORTS_MAX) {
    throw new Error(`A service may declare at most ${SERVICE_PORTS_MAX} ports`);
  }
}

export function createSupervisorServiceCapability(
  transport: SupervisorServiceTransport,
): ComputerServicesCapability {
  const base = (computer: ComputerRef, suffix: string) =>
    `/computers/${encodeURIComponent(computer.id)}/services${suffix}`;
  return {
    async list(computer, context) {
      const response = await supervisorJson(transport, computer, context, {
        method: "GET",
        path: base(computer, ""),
        timeoutMs: SERVICE_CONTROL_TIMEOUT_MS,
      });
      const body = (await response.json()) as { supported?: boolean; services?: unknown[] };
      return {
        supported: body.supported !== false,
        services: (body.services ?? []).map(serviceInfoOf),
      };
    },
    async declare(computer, spec, context) {
      validateSpec(spec);
      await supervisorJson(transport, computer, context, {
        method: "POST",
        path: base(computer, ""),
        body: spec,
        timeoutMs: SERVICE_CONTROL_TIMEOUT_MS,
      });
    },
    async stop(computer, name, context) {
      if (!isValidServiceName(name)) throw new Error(`Invalid service name: ${name}`);
      await supervisorJson(transport, computer, context, {
        method: "POST",
        path: base(computer, `/${encodeURIComponent(name)}/stop`),
        timeoutMs: SERVICE_CONTROL_TIMEOUT_MS,
      });
    },
    async restart(computer, name, context) {
      if (!isValidServiceName(name)) throw new Error(`Invalid service name: ${name}`);
      await supervisorJson(transport, computer, context, {
        method: "POST",
        path: base(computer, `/${encodeURIComponent(name)}/restart`),
        timeoutMs: SERVICE_CONTROL_TIMEOUT_MS,
      });
    },
    async remove(computer, name, context) {
      if (!isValidServiceName(name)) throw new Error(`Invalid service name: ${name}`);
      await supervisorJson(transport, computer, context, {
        method: "DELETE",
        path: base(computer, `/${encodeURIComponent(name)}`),
        timeoutMs: SERVICE_CONTROL_TIMEOUT_MS,
      });
    },
    async preview(computer, request, context) {
      if (!isAllowedServicePort(request.port))
        throw new Error("Preview port is reserved or out of range");
      if (!isValidServiceName(request.name)) {
        throw new Error(`Invalid service name: ${request.name}`);
      }
      // The tunnel path validator bounds every segment; app paths outside that
      // charset are refused here rather than silently rewritten.
      const previewPath = `${base(computer, `/${encodeURIComponent(request.name)}/preview/${request.port}`)}/${request.path.replace(/^\/+/, "")}`;
      if (!isValidMachineTunnelPath(previewPath)) {
        throw new Error("Preview path contains unsupported characters");
      }
      if (request.bodyBase64 && request.bodyBase64.length > PREVIEW_BODY_BASE64_MAX) {
        throw new Error("Preview request body is too large");
      }
      const query = request.query ? `?${request.query}` : "";
      const response = await transport.fetch(transport.url(`${previewPath}${query}`), {
        method: request.method,
        headers: {
          ...transport.headers(context, computer.botId),
          ...(request.contentType ? { "content-type": request.contentType } : {}),
        },
        ...(request.bodyBase64 ? { body: Buffer.from(request.bodyBase64, "base64") } : {}),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(PREVIEW_TIMEOUT_MS)]),
      });
      const bodyBase64 = await response.text();
      if (bodyBase64.length > PREVIEW_BODY_BASE64_MAX) {
        throw new Error("Preview response exceeds the transport bound");
      }
      const result: ComputerServicePreviewResponse = {
        status: response.status,
        contentType: response.headers.get("content-type"),
        bodyBase64: response.status === 204 || response.status === 304 ? null : bodyBase64,
        location: response.headers.get("location"),
      };
      return result;
    },
  };
}

/** The preview body travels as base64 text between container helper and supervisor. */
export function previewRequestBodyBase64(body: string | Uint8Array | null): string | undefined {
  if (body == null || body === "") return undefined;
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > PREVIEW_BODY_MAX_BYTES) {
    throw new Error("Preview request body is too large");
  }
  return Buffer.from(bytes).toString("base64");
}

export const CHANGES_DIFF_LIMIT_BYTES = 128 * 1024;
export const CHANGES_STATUS_LIMIT_BYTES = 32 * 1024;

function boundedCollect(limitBytes: number) {
  return async function collect(
    sandbox: SandboxProvider,
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
  ): Promise<{ output: string; truncated: boolean; failed: boolean }> {
    let output = "";
    let failed = false;
    try {
      for await (const event of sandbox.execute(computer, { argv, timeoutMs: 20_000 }, context)) {
        if (event.type === "stdout" || event.type === "stderr") {
          output += event.data;
        }
        if (event.type === "exit" && event.code !== 0) failed = true;
      }
    } catch {
      failed = true;
    }
    const bytes = Buffer.byteLength(output);
    return {
      output: bytes > limitBytes ? Buffer.from(output).subarray(0, limitBytes).toString() : output,
      truncated: bytes > limitBytes,
      failed,
    };
  };
}

const collectDiff = boundedCollect(CHANGES_DIFF_LIMIT_BYTES);
const collectStatus = boundedCollect(CHANGES_STATUS_LIMIT_BYTES);

/**
 * Read-only review evidence: `git status` + `git diff` with fixed argv through the
 * authorized sandbox exec path. No index refresh, no fetch, no push — the model
 * gains no grants it does not already have.
 */
export async function readComputerChanges(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  input: { cwd: string; paths: string[] },
  context: AdapterContext,
): Promise<{ branch: string | null; status: string; diff: string; truncated: boolean }> {
  if (
    input.paths.some(
      (value) =>
        !value ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.split("/").includes("..") ||
        [...value].some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    throw new Error("Project change paths must be relative workspace files.");
  }
  const safePaths = input.paths;
  const branchArgv = [
    "git",
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ];
  let branch: string | null = null;
  try {
    for await (const event of sandbox.execute(
      computer,
      { argv: branchArgv, cwd: input.cwd, timeoutMs: 10_000 },
      context,
    )) {
      if (event.type === "stdout") branch = (branch ?? "") + event.data;
    }
  } catch {
    branch = null;
  }
  const branchName = branch?.trim() || null;
  const statusArgv = [
    "git",
    "-c",
    "core.fsmonitor=false",
    "--no-optional-locks",
    "--no-pager",
    "--literal-pathspecs",
    "status",
    "--porcelain=v1",
    "--no-renames",
    "--",
    ...safePaths,
  ];
  const status = await collectStatus(sandbox, computer, statusArgv, context);
  const diffArgv = [
    "git",
    "-c",
    "core.fsmonitor=false",
    "--no-pager",
    "--literal-pathspecs",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    ...(safePaths.length ? ["--", ...safePaths] : []),
  ];
  const diff = await collectDiff(sandbox, computer, diffArgv, context);
  return {
    branch: branchName,
    status: status.output,
    diff: diff.output,
    truncated: status.truncated || diff.truncated,
  };
}
