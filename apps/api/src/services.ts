import { createHmac, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  assertServiceWorkspaceCwd,
  previewRequestBodyBase64,
  readComputerChanges,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { type ComputerService, isAllowedServicePort, isValidServiceName } from "@rakazo/contracts";
import { resolveScreenProxySecret } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, IsolationError } from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

export interface ServicesDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  /**
   * Dedicated HMAC secret for preview capability tokens. Defaults to the
   * validated SCREEN_PROXY_SECRET resolution, which refuses known placeholders
   * and empty values outside local development; there is no literal fallback.
   */
  previewSecret?: string;
}

const PREVIEW_TTL_MS = 15 * 60_000;
const PREVIEW_BODY_MAX_BYTES = 4 * 1024 * 1024;
const PREVIEW_REWRITE_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_TOKEN_VERSION = "v1";
const PREVIEW_ID_MAX_LENGTH = 128;
const PREVIEW_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const PREVIEW_HEADERS = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "access-control-allow-origin": "null",
  "x-content-type-options": "nosniff",
  "x-rakazo-preview-ws": "unsupported",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-modals allow-popups",
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function previewSecretOf(deps: ServicesDeps): string {
  const secret = deps.previewSecret ?? resolveScreenProxySecret();
  if (!secret) throw new Error("A non-empty preview secret is required.");
  return secret;
}

export interface PreviewTarget {
  spaceId: string;
  /** Minting user; must keep its space membership for the link to stay valid. */
  userId: string;
  /** Owner of the bot at mint time; ownership changes revoke outstanding links. */
  botOwnerUserId: string;
  /** Tokens authorize the bot, not a computer owner: team non-owners work too. */
  botId: string;
  computerId: string;
  name: string;
  port: number;
  /** Declaration-instance nonce; a re-declared service revokes outstanding links. */
  revision: string;
  expiresAt: number;
}

/** Integrity-sealed, short-lived preview capability; carries no credentials. */
export function sealPreviewToken(secret: string, target: PreviewTarget): string {
  const payload = Buffer.from(JSON.stringify(target)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${PREVIEW_TOKEN_VERSION}.${payload}`)
    .digest("base64url");
  return `${PREVIEW_TOKEN_VERSION}.${payload}.${signature}`;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= PREVIEW_ID_MAX_LENGTH;
}

export function openPreviewToken(secret: string, token: string): PreviewTarget | null {
  if (token.length > 4096 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREVIEW_TOKEN_VERSION) return null;
  const payload = parts[1] ?? "";
  const expected = createHmac("sha256", secret)
    .update(`${PREVIEW_TOKEN_VERSION}.${payload}`)
    .digest();
  const actual = Buffer.from(parts[2] ?? "", "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const target = JSON.parse(Buffer.from(payload, "base64url").toString()) as PreviewTarget;
    if (
      !isBoundedId(target.spaceId) ||
      !isBoundedId(target.userId) ||
      !isBoundedId(target.botOwnerUserId) ||
      !isBoundedId(target.botId) ||
      !isBoundedId(target.computerId) ||
      !isValidServiceName(target.name) ||
      !isAllowedServicePort(target.port) ||
      !Number.isInteger(target.expiresAt) ||
      target.expiresAt <= 0 ||
      typeof target.revision !== "string" ||
      target.revision.length === 0 ||
      target.revision.length > 64
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function runningComputer(deps: ServicesDeps, actor: Actor, botId: string) {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(actor, botId);
  const computer = bot.computer;
  if (!computer) throw new IsolationError();
  if (computer.state !== "running" || !computer.providerRef) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Computer is not running.",
    });
  }
  return { bot, computer };
}

async function requireServicesCapability(deps: ServicesDeps) {
  const services = deps.sandbox.services;
  if (!services) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "This computer provider does not support supervised services.",
    });
  }
  return services;
}

function serviceInfo(raw: {
  name: string;
  status: string;
  pid: number | null;
  ports: number[];
  keepAlive: boolean;
  cwd: string;
  revision?: string;
}): ComputerService {
  return {
    name: raw.name,
    status: ("running stopped exited fatal unknown".split(" ").includes(raw.status)
      ? raw.status
      : "unknown") as ComputerService["status"],
    pid: raw.pid,
    ports: raw.ports,
    keepAlive: raw.keepAlive,
    cwd: raw.cwd,
    revision: raw.revision,
  };
}

export async function listServices(deps: ServicesDeps, actor: Actor, botId: string) {
  const { bot, computer } = await runningComputer(deps, actor, botId);
  const services = await requireServicesCapability(deps);
  try {
    const result = await services.list(toComputerRef(computer), {
      operationId: `services.list:${botId}`,
      traceId: `services.list:${botId}`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      signal: new AbortController().signal,
    });
    return {
      supported: result.supported,
      services: result.services.map(serviceInfo),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/service request failed \(501\)/.test(message) || /unreachable/.test(message)) {
      return { supported: false, services: [] as ComputerService[] };
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Service listing failed." });
  }
}

export async function declareService(
  deps: ServicesDeps,
  actor: Actor,
  input: {
    botId: string;
    name: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    ports: number[];
    keepAlive: boolean;
  },
) {
  const { computer } = await runningComputer(deps, actor, input.botId);
  // A team computer is shared: a service must never run inside another bot's
  // private area, only the declaring bot's own area or shared/.
  assertServiceWorkspaceCwd(computer.scope, input.botId, input.cwd);
  const services = await requireServicesCapability(deps);
  try {
    await services.declare(
      toComputerRef(computer),
      {
        name: input.name,
        argv: input.argv,
        cwd: input.cwd,
        env: input.env,
        ports: input.ports,
        keepAlive: input.keepAlive,
      },
      {
        operationId: `services.declare:${input.botId}:${input.name}`,
        traceId: `services.declare:${input.botId}:${input.name}`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: input.botId,
        signal: new AbortController().signal,
      },
    );
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Service declaration failed.",
    });
  }
  return { ok: true as const };
}

async function serviceAction(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; name: string },
  action: "stop" | "restart" | "remove",
) {
  const { computer } = await runningComputer(deps, actor, input.botId);
  const services = await requireServicesCapability(deps);
  try {
    await services[action](toComputerRef(computer), input.name, {
      operationId: `services.${action}:${input.botId}:${input.name}`,
      traceId: `services.${action}:${input.botId}:${input.name}`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: input.botId,
      signal: new AbortController().signal,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Service action failed.",
    });
  }
  return { ok: true as const };
}

export function stopService(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; name: string },
) {
  return serviceAction(deps, actor, input, "stop");
}

export function restartService(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; name: string },
) {
  return serviceAction(deps, actor, input, "restart");
}

export function removeService(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; name: string },
) {
  return serviceAction(deps, actor, input, "remove");
}

export async function serviceChanges(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; cwd: string; paths: string[] },
) {
  const { computer } = await runningComputer(deps, actor, input.botId);
  assertServiceWorkspaceCwd(computer.scope, input.botId, input.cwd);
  try {
    return await readComputerChanges(
      deps.sandbox,
      toComputerRef(computer),
      { cwd: input.cwd, paths: input.paths },
      {
        operationId: `services.changes:${input.botId}`,
        traceId: `services.changes:${input.botId}`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: input.botId,
        signal: new AbortController().signal,
      },
    );
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not read project changes.",
    });
  }
}

export async function servicePreviewUrl(
  deps: ServicesDeps,
  actor: Actor,
  input: { botId: string; name: string; port: number },
) {
  const { bot, computer } = await runningComputer(deps, actor, input.botId);
  const services = await requireServicesCapability(deps);
  const listed = await services.list(toComputerRef(computer), {
    operationId: `services.previewUrl:${input.botId}`,
    traceId: `services.previewUrl:${input.botId}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  });
  const service = listed.services.find((entry) => entry.name === input.name);
  if (!service) {
    throw new ORPCError("NOT_FOUND", { message: "Unknown service." });
  }
  if (!isAllowedServicePort(input.port) || !service.ports.includes(input.port)) {
    // The allowlist comes only from ports the service declared.
    throw new ORPCError("BAD_REQUEST", { message: "Port is not declared by this service." });
  }
  if (typeof service.revision !== "string" || !service.revision || service.revision.length > 64) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Update the computer service runtime before opening a preview.",
    });
  }
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const token = sealPreviewToken(previewSecretOf(deps), {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botOwnerUserId: bot.userId,
    botId: input.botId,
    computerId: computer.id,
    name: input.name,
    port: input.port,
    revision: service.revision,
    expiresAt,
  });
  return {
    path: `/api/preview/${encodeURIComponent(token)}/`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export interface ServicePreviewRouteDeps extends ServicesDeps {}

/**
 * Authenticated HTTP previews for supervised services. Authorization rides
 * ONLY the sealed token: cookies are ignored and never forwarded, the response
 * is forced onto an opaque origin via CSP sandbox, and WebSockets fail with an
 * explicit 501 because no transport here carries them. Every fetch
 * reauthorizes against the current bot assignment, archive state, and the
 * service's declared ports, so reassignment, archiving, and redeclaration all
 * revoke outstanding links immediately.
 */
export function mountServicePreviewRoutes(app: Hono, deps: ServicePreviewRouteDeps): void {
  const secret = previewSecretOf(deps);
  const respond = (
    target: PreviewTarget,
    token: string,
    request: Request,
    subPath: string,
    url: URL,
  ) => respondPreview(deps, secret, target, token, request, subPath, url);
  app.all("/api/preview/:token", (c) => {
    const token = c.req.param("token") ?? "";
    const opened = openOr401(token);
    if ("response" in opened) return opened.response;
    return respond(opened.target, token, c.req.raw, "", new URL(c.req.url));
  });
  app.all("/api/preview/:token/*", (c) => {
    const url = new URL(c.req.url);
    const marker = "/api/preview/";
    const after = url.pathname.slice(marker.length);
    const tokenEnd = after.indexOf("/");
    const token = tokenEnd === -1 ? after : after.slice(0, tokenEnd);
    const subPath = tokenEnd === -1 ? "" : after.slice(tokenEnd + 1);
    const opened = openOr401(decodeURIComponent(token));
    if ("response" in opened) return opened.response;
    return respond(opened.target, token, c.req.raw, subPath, url);
  });

  function openOr401(token: string): { target: PreviewTarget } | { response: Response } {
    const target = openPreviewToken(secret, token);
    if (!target || target.expiresAt <= Date.now()) {
      return {
        response: previewJson(401, "Preview link expired or invalid."),
      };
    }
    return { target };
  }
}

function previewJson(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...PREVIEW_HEADERS, "content-type": "application/json" },
  });
}

/**
 * Root-absolute URLs would otherwise resolve against the Rakazo API origin.
 * Rewrite quoted src/href/action/poster attributes and css url() references in
 * HTML/CSS bodies onto the token-prefixed route. Bounded and best-effort:
 * prefix-aware apps that configure a base path remain the robust answer, and
 * relative URLs always work without rewriting.
 */
export function rewritePreviewBody(body: string, prefix: string): string {
  const withAttrs = body.replace(
    /(\s(?:src|href|action|poster)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
    (_match, lead: string, quote: string, rest: string) =>
      `${lead}${quote}${prefix}/${rest}${quote}`,
  );
  return withAttrs.replace(
    /url\(\s*(["']?)\/(?!\/)([^"')]*?)\1\s*\)/gi,
    (_match, quote: string, rest: string) => `url(${quote}${prefix}/${rest}${quote})`,
  );
}

function rewritePreviewLocation(location: string, prefix: string, port: number): string {
  if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
  try {
    const parsed = new URL(location, `http://127.0.0.1:${port}`);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (loopback && parsed.port === String(port)) {
      return `${prefix}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // pass through unparseable locations untouched
  }
  return location;
}

async function respondPreview(
  deps: ServicePreviewRouteDeps,
  secret: string,
  target: PreviewTarget,
  token: string,
  request: Request,
  subPath: string,
  url: URL,
): Promise<Response> {
  const prefix = `/api/preview/${token}`;
  try {
    // Reauthorize on every fetch: the minting user must keep its space
    // membership, and the bot must keep its owner, stay unarchived, and remain
    // assigned to the token's computer.
    const [member, bot] = await Promise.all([
      deps.prisma.spaceMember.findFirst({
        where: { userId: target.userId, spaceId: target.spaceId },
        select: { id: true },
      }),
      deps.prisma.bot.findFirst({
        where: {
          id: target.botId,
          spaceId: target.spaceId,
          archivedAt: null,
          computerId: target.computerId,
        },
        select: { userId: true },
      }),
    ]);
    if (!member || !bot || bot.userId !== target.botOwnerUserId) {
      return previewJson(401, "Preview link expired or invalid.");
    }
    const computer = await deps.prisma.computer.findUnique({
      where: { id: target.computerId },
      select: {
        id: true,
        spaceId: true,
        state: true,
        providerRef: true,
        homeKey: true,
        kind: true,
      },
    });
    if (!computer || computer.spaceId !== target.spaceId) {
      return previewJson(401, "Preview link expired or invalid.");
    }
    const services = deps.sandbox.services;
    if (!services) return previewJson(501, "Preview is unavailable.");
    if (computer.state !== "running" || !computer.providerRef) {
      return previewJson(409, "The computer running this preview is not active.");
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      return previewJson(501, "Preview does not support WebSockets.");
    }
    const method = request.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    const preflight = request.method === "OPTIONS";
    if (!preflight && !PREVIEW_METHODS.has(method)) {
      return previewJson(405, "Preview method not allowed.");
    }
    let bodyBase64: string | undefined;
    if (!preflight && method !== "GET" && method !== "HEAD") {
      const raw = await readBoundedBody(request, PREVIEW_BODY_MAX_BYTES);
      if (raw === null) return previewJson(413, "Preview request body is too large.");
      bodyBase64 = previewRequestBodyBase64(raw);
    }
    // The service must still exist and still declare the token's port; this
    // revokes links to removed or redeclared services.
    const listed = await services.list(toComputerRef(computer), {
      operationId: `preview:${target.computerId}:${target.name}`,
      traceId: `preview:${target.computerId}:${target.name}`,
      spaceId: target.spaceId,
      userId: target.userId,
      botId: target.botId,
      signal: new AbortController().signal,
    });
    const live = listed.services.find((entry) => entry.name === target.name);
    if (!live || !live.ports.includes(target.port) || live.revision !== target.revision) {
      return previewJson(404, "This preview target is gone.");
    }
    if (preflight) {
      const requestedMethod = request.headers.get("access-control-request-method") ?? "GET";
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        !PREVIEW_METHODS.has(requestedMethod) ||
        requestedHeaders.some((header) => header !== "content-type")
      ) {
        return previewJson(405, "Preview method or header not allowed.");
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...PREVIEW_HEADERS,
          "access-control-allow-methods": [...PREVIEW_METHODS].join(", "),
          "access-control-allow-headers": "content-type",
        },
      });
    }
    const result = await services.preview(
      toComputerRef(computer),
      {
        name: target.name,
        port: target.port,
        method,
        path: `/${subPath}`,
        query: url.search.startsWith("?") ? url.search.slice(1) : "",
        contentType: request.headers.get("content-type") ?? undefined,
        bodyBase64,
      },
      {
        operationId: `preview:${target.computerId}:${target.name}`,
        traceId: `preview:${target.computerId}:${target.name}`,
        spaceId: target.spaceId,
        userId: target.userId,
        botId: target.botId,
        signal: new AbortController().signal,
      },
    );
    const noBody = method === "HEAD" || result.status === 204 || result.status === 304;
    const rawBody = result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64") : null;
    const contentType = result.contentType ?? "";
    let body: BodyInit | null = null;
    if (!noBody && rawBody) {
      if (
        rawBody.byteLength <= PREVIEW_REWRITE_MAX_BYTES &&
        /^text\/(html|css)\b/i.test(contentType)
      ) {
        body = rewritePreviewBody(rawBody.toString("utf8"), prefix);
      } else {
        const copy = new Uint8Array(rawBody.byteLength);
        copy.set(rawBody);
        body = copy;
      }
    }
    const headers: Record<string, string> = { ...PREVIEW_HEADERS };
    if (result.contentType) headers["content-type"] = result.contentType;
    if (REDIRECT_STATUSES.has(result.status) && result.location && result.location.length <= 2048) {
      headers.location = rewritePreviewLocation(result.location, prefix, target.port);
    }
    return new Response(body, { status: result.status as 200, headers });
  } catch {
    return previewJson(502, "Preview failed.");
  }
}
