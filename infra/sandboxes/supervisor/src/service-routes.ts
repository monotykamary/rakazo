import {
  isAllowedServicePort,
  isValidServiceName,
  SERVICE_NAME_PATTERN,
  SERVICE_PORTS_MAX,
  ServicePortSchema,
} from "@rakazo/contracts";
import type Docker from "dockerode";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { normalizeWorkspaceRelative, workspaceTarget } from "./supervisor-logic.js";

const SERVICE_CONTROL_TIMEOUT_MS = 25_000;
const PREVIEW_TIMEOUT_MS = 20_000;
export const PREVIEW_BODY_MAX_BYTES = 8 * 1024 * 1024;

const serviceSpecSchema = z.object({
  name: z.string().regex(SERVICE_NAME_PATTERN),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
  /** Container path; virtual workspace paths are translated before exec. */
  cwd: z.string().min(1).max(1024),
  // Entry count is bounded by the shared contracts schema at the API edge.
  env: z.record(z.string().min(1).max(256), z.string().max(8192)).default({}),
  ports: z.array(ServicePortSchema).max(SERVICE_PORTS_MAX).default([]),
  keepAlive: z.boolean().default(false),
});

export interface ServiceRouteDeps {
  /** Resolves the managed computer container, enforcing bot/space identity labels. */
  managedContainer(
    id: string,
    botId: string | undefined,
    spaceId: string | undefined,
  ): Promise<{ container: Docker.Container; info: Docker.ContainerInspectInfo }>;
}

interface ContainerCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** One docker exec with a bounded stdin payload and a hard wall-clock timeout. */
async function runContainerCommandWithStdin(
  container: Docker.Container,
  argv: string[],
  stdin: string,
  timeoutMs: number,
): Promise<ContainerCommandResult> {
  const exec = await container.exec({
    Cmd: argv,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    WorkingDir: "/home/rakazo",
    Env: ["HOME=/home/rakazo", "PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const chunks: Buffer[] = [];
  const timeout = AbortSignal.timeout(timeoutMs);
  const onAbort = () => {
    stream.destroy();
  };
  timeout.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (data: Buffer) => chunks.push(data));
      stream.on("end", resolve);
      stream.on("error", reject);
      stream.write(stdin, () => stream.end());
    });
  } finally {
    timeout.removeEventListener("abort", onAbort);
  }
  const inspect = await exec.inspect();
  const output = demux(Buffer.concat(chunks));
  return { stdout: output.stdout, stderr: output.stderr, code: inspect.ExitCode ?? 0 };
}

function demux(buffer: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    const chunk = buffer.subarray(offset + 8, Math.min(offset + 8 + length, buffer.length));
    (type === 2 ? stderr : stdout).push(chunk);
    offset += 8 + length;
  }
  return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

function ctlArgv(subcommand: string): string[] {
  return ["python3", "/usr/local/bin/rakazo-service-ctl", subcommand];
}

/** Translate a virtual workspace path (bots/<id>/...) into a container path. */
export function serviceWorkingDirectory(cwd: string): string {
  if (cwd.startsWith("/")) {
    if (!cwd.startsWith("/home/rakazo") || cwd.includes("..")) {
      throw new Error("service cwd must be inside the computer home");
    }
    return cwd;
  }
  return workspaceTarget(normalizeWorkspaceRelative(cwd));
}

async function serviceControl(
  deps: ServiceRouteDeps,
  c: Context,
  subcommand: string,
  stdinPayload: unknown,
): Promise<Response> {
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing computer id." }, 400);
    const { container } = await deps.managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    const result = await runContainerCommandWithStdin(
      container,
      ctlArgv(subcommand),
      JSON.stringify(stdinPayload ?? {}),
      SERVICE_CONTROL_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return c.json(
        { error: result.stderr.trim().slice(-400) || "service control failed" },
        result.code === 2 ? 501 : 400,
      );
    }
    return c.body(result.stdout.trim() || "{}", 200, { "content-type": "application/json" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}

/**
 * Supervised project services. The runtime lives in the computer container
 * (distro supervisord); these routes only translate validated requests into
 * one container exec of the in-image control helper, so services survive Pi
 * worker restarts and every transport (direct, machine tunnel) works alike.
 */
export function registerServiceRoutes(app: Hono, deps: ServiceRouteDeps): void {
  app.get("/computers/:id/services", async (c) => serviceControl(deps, c, "list", {}));

  app.post("/computers/:id/services", async (c) => {
    const parsed = serviceSpecSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid service declaration." }, 400);
    const spec = parsed.data;
    let cwd: string;
    try {
      cwd = serviceWorkingDirectory(spec.cwd);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid cwd" }, 400);
    }
    return serviceControl(deps, c, "up", { ...spec, cwd });
  });

  app.post("/computers/:id/services/:name/stop", async (c) => {
    if (!isValidServiceName(c.req.param("name"))) {
      return c.json({ error: "Invalid service name." }, 400);
    }
    return serviceControl(deps, c, "stop", { name: c.req.param("name") });
  });

  app.post("/computers/:id/services/:name/restart", async (c) => {
    if (!isValidServiceName(c.req.param("name"))) {
      return c.json({ error: "Invalid service name." }, 400);
    }
    return serviceControl(deps, c, "restart", { name: c.req.param("name") });
  });

  app.delete("/computers/:id/services/:name", async (c) => {
    if (!isValidServiceName(c.req.param("name"))) {
      return c.json({ error: "Invalid service name." }, 400);
    }
    return serviceControl(deps, c, "remove", { name: c.req.param("name") });
  });

  // Preview: the fetch happens inside the container over loopback through the
  // same exec transport, so no raw container port is published anywhere.
  app.all("/computers/:id/services/:name/preview/:port/*", (c) => preview(deps, c));
  app.all("/computers/:id/services/:name/preview/:port", (c) => preview(deps, c));
}

async function preview(deps: ServiceRouteDeps, c: Context): Promise<Response> {
  const name = c.req.param("name") ?? "";
  const portParam = c.req.param("port") ?? "";
  const port = Number(portParam);
  if (!isValidServiceName(name)) return c.json({ error: "Invalid service name." }, 400);
  if (!isAllowedServicePort(port)) {
    return c.json({ error: "Invalid preview port." }, 400);
  }
  if ((c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
    // Fail explicitly: the tunnel and exec transports carry no WebSockets.
    return c.json({ error: "Preview does not support WebSockets." }, 501);
  }
  let rawBody: ArrayBuffer | undefined;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    rawBody = await c.req.arrayBuffer();
    if (rawBody.byteLength > PREVIEW_BODY_MAX_BYTES) {
      return c.json({ error: "Preview request body is too large." }, 413);
    }
  }
  const url = new URL(c.req.url);
  const request = {
    method: c.req.method,
    path: `/${url.pathname.split(`/preview/${portParam}/`)[1] ?? ""}`,
    query: url.search.startsWith("?") ? url.search.slice(1) : "",
    contentType: c.req.header("content-type") ?? undefined,
    bodyBase64: rawBody?.byteLength ? Buffer.from(rawBody).toString("base64") : undefined,
    maxBytes: PREVIEW_BODY_MAX_BYTES,
  };
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing computer id." }, 400);
    const { container } = await deps.managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    const result = await runContainerCommandWithStdin(
      container,
      ctlArgv("http"),
      JSON.stringify({ ...request, name, port }),
      PREVIEW_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return c.json({ error: result.stderr.trim().slice(-400) || "preview failed" }, 502);
    }
    const payload = JSON.parse(result.stdout || "{}") as {
      status?: number;
      contentType?: string | null;
      bodyBase64?: string | null;
      location?: string | null;
    };
    const status = (typeof payload.status === "number" ? payload.status : 502) as 200;
    const bytes = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, "base64") : Buffer.alloc(0);
    const headers: Record<string, string> = {
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-rakazo-preview-ws": "unsupported",
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    };
    if (payload.contentType) headers["content-type"] = payload.contentType;
    if (typeof payload.location === "string" && payload.location.length <= 2048) {
      headers.location = payload.location;
    }
    return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, status, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}
