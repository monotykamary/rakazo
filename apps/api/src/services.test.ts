import type { ComputerServiceInfo } from "@rakazo/adapter-kit";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";
import {
  listServices,
  mountServicePreviewRoutes,
  openPreviewToken,
  sealPreviewToken,
  servicePreviewUrl,
} from "./services.js";

const SECRET = "test-preview-secret-0123456789abcdef";
const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "o@rakazo.test",
  isDeploymentOwner: true,
};
const botRow = { id: "bot-1", userId: "user-1" };

function computerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "comp-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    scope: "team",
    state: "running",
    providerRef: "comp-1",
    homeKey: "bot-1",
    kind: "docker",
    ...overrides,
  };
}

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: actor.spaceId,
  userId: actor.userId,
  botId: "bot-1",
  signal: new AbortController().signal,
};

function servicesStub(overrides: Partial<Record<string, unknown>> = {}) {
  const list = async () => ({
    supported: true,
    services: [
      {
        name: "web",
        status: "running",
        pid: 5,
        ports: [3000, 5173],
        keepAlive: false,
        cwd: "bots/bot-1/app",
        revision: "rev-1",
      },
    ] as ComputerServiceInfo[],
  });
  return {
    list: overrides.list ?? list,
    declare: overrides.declare ?? (async () => undefined),
    stop: overrides.stop ?? (async () => undefined),
    restart: overrides.restart ?? (async () => undefined),
    remove: overrides.remove ?? (async () => undefined),
    preview:
      overrides.preview ??
      (async () => ({
        status: 200,
        contentType: "text/html",
        bodyBase64: Buffer.from("<html>ok</html>").toString("base64"),
      })),
  };
}

function deps(
  sandboxOverrides: Partial<Record<string, unknown>> = {},
  row: Record<string, unknown> = computerRow(),
  dbOverrides: {
    botFirst?: (args: { where: Record<string, string | null> }) => Promise<unknown>;
    memberFirst?: (args: { where: Record<string, string> }) => Promise<unknown>;
  } = {},
) {
  return {
    previewSecret: SECRET,
    prisma: {
      bot: {
        findFirst: async (args: { where: Record<string, string | null> }) => {
          if (dbOverrides.botFirst) return dbOverrides.botFirst(args);
          const where = args.where ?? {};
          if (where.id && where.id !== "bot-1") return null;
          if (where.spaceId && where.spaceId !== actor.spaceId) return null;
          // Reauthorization-shaped query: bound to the token's computer.
          if (where.computerId !== undefined && where.computerId !== null) {
            if (where.computerId !== row.id) return null;
            return { id: "bot-1", userId: "user-1" };
          }
          return { id: "bot-1", userId: "user-1", computer: row };
        },
      },
      spaceMember: {
        findFirst: dbOverrides.memberFirst ?? (async () => ({ id: "m-1" })),
      },
      computer: {
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === row.id ? row : null,
      },
    } as never,
    sandbox: { services: servicesStub(sandboxOverrides) } as never,
  };
}

function mintTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botOwnerUserId: "user-1",
    botId: "bot-1",
    computerId: "comp-1",
    name: "web",
    port: 3000,
    revision: "rev-1",
    expiresAt: Date.now() + 1000,
    ...overrides,
  } as Parameters<typeof sealPreviewToken>[1];
}

it("owns preview preflight without inheriting API credentialed CORS and preserves actor identity", async () => {
  let previews = 0;
  const app = new Hono();
  mountServicePreviewRoutes(
    app,
    deps({
      preview: async (_computer: unknown, _input: unknown, ctx: { userId: string }) => {
        previews += 1;
        expect(ctx.userId).toBe(actor.userId);
        return {
          status: 200,
          contentType: "application/json",
          bodyBase64: Buffer.from("{}").toString("base64"),
        };
      },
    }),
  );
  app.use(
    "*",
    cors({
      origin: (origin) => (origin === "https://trusted.example" ? origin : ""),
      credentials: true,
    }),
  );
  app.get("/outside", (c) => c.json({ ok: true }));
  const path = `/api/preview/${sealPreviewToken(SECRET, mintTarget())}/echo`;
  const response = await app.request(path, {
    method: "OPTIONS",
    headers: {
      origin: "null",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("null");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(previews).toBe(0);
  const denied = await app.request(path, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
  });
  expect(denied.status).toBe(405);
  const posted = await app.request(path, {
    method: "POST",
    headers: { origin: "null", "content-type": "application/json" },
    body: "{}",
  });
  expect(posted.status).toBe(200);
  expect(previews).toBe(1);
  expect(posted.headers.get("access-control-allow-credentials")).toBeNull();
  expect(
    (await app.request("/outside", { headers: { origin: "null" } })).headers.get(
      "access-control-allow-origin",
    ),
  ).toBeNull();
});
describe("preview capability tokens", () => {
  it("round-trips and binds scope", () => {
    const token = sealPreviewToken(SECRET, mintTarget());
    const opened = openPreviewToken(SECRET, token);
    expect(opened?.name).toBe("web");
    expect(opened?.port).toBe(3000);
    expect(opened?.botId).toBe("bot-1");
    expect(opened?.revision).toBe("rev-1");
  });

  it("rejects noncanonical or oversized tokens and missing declaration generations", () => {
    const token = sealPreviewToken(SECRET, mintTarget());
    expect(openPreviewToken(SECRET, `${token}!`)).toBeNull();
    expect(openPreviewToken(SECRET, `v1.${"a".repeat(4097)}.${"b".repeat(43)}`)).toBeNull();
    for (const revision of [undefined, "", "x".repeat(65)]) {
      expect(
        openPreviewToken(SECRET, sealPreviewToken(SECRET, mintTarget({ revision }))),
      ).toBeNull();
    }
  });
  it("rejects tampering", () => {
    const token = sealPreviewToken(SECRET, mintTarget());
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
    payload.port = 22;
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
    expect(openPreviewToken(SECRET, forged)).toBeNull();
  });

  it("rejects wrong secrets", () => {
    const token = sealPreviewToken(SECRET, mintTarget());
    expect(openPreviewToken("another-secret-0123456789abcdef", token)).toBeNull();
  });

  it("rejects out-of-bounds ports and non-finite expiry", () => {
    expect(openPreviewToken(SECRET, sealPreviewToken(SECRET, mintTarget({ port: 22 })))).toBeNull();
    expect(
      openPreviewToken(SECRET, sealPreviewToken(SECRET, mintTarget({ port: 70000 }))),
    ).toBeNull();
    expect(
      openPreviewToken(SECRET, sealPreviewToken(SECRET, mintTarget({ expiresAt: Number.NaN }))),
    ).toBeNull();
  });

  it("expired tokens still open but callers reject them on time", () => {
    const opened = openPreviewToken(
      SECRET,
      sealPreviewToken(SECRET, mintTarget({ expiresAt: Date.now() - 1 })),
    );
    expect(opened).not.toBeNull();
    expect(opened?.expiresAt ?? 0).toBeLessThan(Date.now());
  });
});

describe("services API", () => {
  it("refuses preview links when the provider cannot identify a declaration generation", async () => {
    const input = deps({
      list: async () => ({ supported: true, services: [{ name: "web", ports: [3000] }] }),
    });
    await expect(
      servicePreviewUrl(input, actor, { botId: "bot-1", name: "web", port: 3000 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("lists services for an owned bot", async () => {
    const result = await listServices(deps(), actor, "bot-1");
    expect(result.supported).toBe(true);
    expect(result.services[0]?.name).toBe("web");
    expect(result.services[0]?.revision).toBe("rev-1");
  });

  it("binds preview urls to ports the service declared", async () => {
    await expect(
      servicePreviewUrl(deps(), actor, { botId: "bot-1", name: "web", port: 3000 }),
    ).resolves.toMatchObject({ path: expect.stringContaining("/api/preview/") });
    await expect(
      servicePreviewUrl(deps(), actor, { botId: "bot-1", name: "web", port: 22 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      servicePreviewUrl(deps(), actor, { botId: "bot-1", name: "ghost", port: 3000 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("preview HTTP route", () => {
  function previewApp(
    sandboxOverrides: Partial<Record<string, unknown>> = {},
    row: Record<string, unknown> = computerRow(),
    dbOverrides: Partial<Record<string, unknown>> = {},
  ) {
    const app = new Hono();
    mountServicePreviewRoutes(app, deps(sandboxOverrides, row, dbOverrides));
    return app;
  }

  async function url() {
    const result = await servicePreviewUrl(deps(), actor, {
      botId: "bot-1",
      name: "web",
      port: 3000,
    });
    return result.path;
  }

  it("serves proxied content on an opaque origin without forwarding cookies", async () => {
    const app = previewApp({
      preview: async (computer, request) => {
        expect(request.name).toBe("web");
        expect(request.port).toBe(3000);
        expect(request.path).toBe("/index.html");
        return {
          status: 200,
          contentType: "text/html",
          bodyBase64: Buffer.from("<html>ok</html>").toString("base64"),
          location: null,
        };
      },
    });
    const res = await app.request(`${await url()}index.html`, {
      headers: { cookie: "better-auth.session_token=stolen-value" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("<html>ok</html>");
  });

  it("serves opaque-origin CORS and nosniff headers for module scripts", async () => {
    const app = previewApp();
    const res = await app.request(`${await url()}src/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rewrites root-absolute html assets onto the token route", async () => {
    const app = previewApp({
      preview: async () => ({
        status: 200,
        contentType: "text/html; charset=utf-8",
        bodyBase64: Buffer.from(
          '<html><head><link href="/vite.svg"><script src="/src/main.tsx"></script><link href="//cdn.example/x.css" rel="stylesheet"><style>body{background:url(/bg.png)}</style></head><body></body></html>',
        ).toString("base64"),
        location: null,
      }),
    });
    const tokenPath = await url();
    const res = await app.request(`${tokenPath}`);
    const text = await res.text();
    expect(text).toContain(`href="${tokenPath}vite.svg"`);
    expect(text).toContain(`src="${tokenPath}src/main.tsx"`);
    expect(text).toContain('href="//cdn.example/x.css"');
    expect(text).toContain(`url(${tokenPath}bg.png)`);
  });

  it("answers 204 and HEAD without a body instead of failing", async () => {
    const app = previewApp({
      preview: async () => ({ status: 204, contentType: null, bodyBase64: null, location: null }),
    });
    const noContent = await app.request(`${await url()}health`);
    expect(noContent.status).toBe(204);
    expect(await noContent.text()).toBe("");
    const head = previewApp();
    const headRes = await head.request(`${await url()}`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
  });

  it("rewrites same-service redirects and passes external ones through tokenless", async () => {
    const app = previewApp({
      preview: async (_computer, request) => ({
        status: 302,
        contentType: null,
        bodyBase64: null,
        location:
          request.path === "/same" ? "http://127.0.0.1:3000/login" : "https://auth.example.net/sso",
      }),
    });
    const tokenPath = await url();
    const same = await app.request(`${tokenPath}same`);
    expect(same.headers.get("location")).toBe(`${tokenPath}login`);
    const external = await app.request(`${tokenPath}external`);
    expect(external.headers.get("location")).toBe("https://auth.example.net/sso");
  });

  it("reauthorizes membership, bot ownership, assignment, and declaration revision per fetch", async () => {
    const tokenPath = await url();
    const gone = await previewApp({}, computerRow(), { memberFirst: async () => null }).request(
      tokenPath,
    );
    expect(gone.status).toBe(401);
    const moved = await previewApp({}, computerRow(), {
      botFirst: async () => ({ id: "bot-1", userId: "someone-else" }),
    }).request(tokenPath);
    expect(moved.status).toBe(401);
    const reassigned = await previewApp({}, computerRow({ id: "comp-2" })).request(tokenPath);
    expect(reassigned.status).toBe(401);
    const redeclared = await previewApp({
      list: async () => ({
        supported: true,
        services: [
          {
            name: "web",
            status: "running",
            pid: 5,
            ports: [3000],
            keepAlive: false,
            cwd: "bots/bot-1/app",
            revision: "rev-2",
          },
        ] as ComputerServiceInfo[],
      }),
    }).request(tokenPath);
    expect(redeclared.status).toBe(404);
    const removed = await previewApp({
      list: async () => ({ supported: true, services: [] as ComputerServiceInfo[] }),
    }).request(tokenPath);
    expect(removed.status).toBe(404);
  });

  it("authenticates only by token, not by session cookie", async () => {
    const app = previewApp();
    const res = await app.request("/api/preview/forged.token.sig/index.html", {
      headers: { cookie: "better-auth.session_token=valid-session" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses websocket upgrades explicitly", async () => {
    const app = previewApp();
    const res = await app.request(await url(), {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/WebSockets/);
  });

  it("fails closed when the computer moved spaces or vanished", async () => {
    const app = previewApp({}, computerRow({ spaceId: "space-2" }));
    const res = await app.request(`${await url()}index.html`);
    expect(res.status).toBe(401);
  });
});
