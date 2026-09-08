import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import type { ComputerServicesCapability, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { expect, it } from "vitest";
import { mountServicePreviewRoutes, sealPreviewToken } from "../../../apps/api/src/services.js";

// Opt-in headless Chromium probe; no Docker, database, vendor, or Electron window.
it.skipIf(process.env.VERIFY_BROWSER !== "1")(
  "renders opaque-origin preview modules, assets and JSON POSTs without API access",
  async () => {
    const secret = "preview-browser-fixture-secret-0123456789";
    let revision = "first";
    const seen: string[] = [];
    const files: Record<string, [string, string]> = {
      "/": [
        "text/html",
        '<!doctype html><link rel="stylesheet" href="/style.css"><p id="result">loading</p><script type="module" src="/main.js"></script>',
      ],
      "/style.css": [
        "text/css",
        '#result { text-transform: uppercase; background-image: url("/picture.svg"); }',
      ],
      "/picture.svg": [
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      ],
      "/nested/module.js": ["text/javascript", 'export const value = "module";'],
      "/data.json": ["application/json", '{"value":"data"}'],
      "/landing": ["text/html", "landed"],
      "/main.js": [
        "text/javascript",
        `import { value } from './nested/module.js';
const data = await fetch('./data.json?probe=1').then(r => r.json());
const post = await fetch('./echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'post' }) }).then(r => r.json());
let opaque = false; try { parent.document.body; } catch { opaque = true; }
let blocked = false; try { await fetch('/outside'); } catch { blocked = true; }
document.querySelector('#result').textContent = [value, data.value, post.value, opaque, blocked].join(' ');`,
      ],
    };
    const services: ComputerServicesCapability = {
      list: async () => ({
        supported: true,
        services: [
          {
            name: "web",
            status: "running",
            pid: 1,
            ports: [3000],
            cwd: "app",
            keepAlive: false,
            revision,
          },
        ],
      }),
      declare: async () => {},
      stop: async () => {},
      restart: async () => {},
      remove: async () => {},
      preview: async (_computer, request, context) => {
        expect(context.userId).toBe("owner");
        seen.push(request.path + (request.query ? `?${request.query}` : ""));
        if (request.path === "/redirect") return { status: 302, location: "/landing" };
        if (request.method === "DELETE")
          return { status: 204, bodyBase64: Buffer.from("must not be sent").toString("base64") };
        if (request.path === "/echo") {
          expect(request.contentType).toBe("application/json");
          return { status: 200, contentType: "application/json", bodyBase64: request.bodyBase64 };
        }
        const entry = files[request.path];
        return entry
          ? {
              status: 200,
              contentType: entry[0],
              bodyBase64: Buffer.from(entry[1]).toString("base64"),
            }
          : { status: 404 };
      },
    };
    const prisma = {
      spaceMember: { findFirst: async () => ({ id: "member" }) },
      bot: { findFirst: async () => ({ userId: "owner" }) },
      computer: {
        findUnique: async () => ({
          id: "computer",
          spaceId: "space",
          state: "running",
          providerRef: "computer",
          homeKey: "home",
          kind: "docker",
        }),
      },
    } as unknown as PrismaClient;
    const token = sealPreviewToken(secret, {
      spaceId: "space",
      userId: "owner",
      botOwnerUserId: "owner",
      botId: "bot",
      computerId: "computer",
      name: "web",
      port: 3000,
      revision,
      expiresAt: Date.now() + 60_000,
    });
    const prefix = `/api/preview/${token}`;
    const app = new Hono();
    mountServicePreviewRoutes(app, {
      prisma,
      sandbox: { services } as SandboxProvider,
      previewSecret: secret,
    });
    // Matches API composition: token-only previews precede credentialed API CORS.
    app.use(
      "*",
      cors({
        origin: (origin) => (origin === "https://trusted.example" ? origin : ""),
        credentials: true,
      }),
    );
    app.get("/outside", (c) => c.text("not available to the preview"));
    app.get("/", (c) => c.html(`<iframe id="preview" src="${prefix}/"></iframe>`));
    let origin = "";
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
      origin = `http://127.0.0.1:${address.port}`;
    });
    await new Promise<void>((resolve) => {
      if (origin) resolve();
      else server.once("listening", resolve);
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(origin);
      const result = page.frameLocator("#preview").locator("#result");
      await expect.poll(() => result.textContent()).toBe("module data post true true");
      expect(await result.evaluate((element) => getComputedStyle(element).textTransform)).toBe(
        "uppercase",
      );
      await expect.poll(() => seen.includes("/picture.svg")).toBe(true);
      expect(seen).toContain("/nested/module.js");
      expect(seen).toContain("/data.json?probe=1");
      const redirect = await page.request.get(`${origin}${prefix}/redirect`, { maxRedirects: 0 });
      expect(redirect.headers().location).toBe(`${prefix}/landing`);
      expect(await (await page.request.get(`${origin}${prefix}/redirect`)).text()).toBe("landed");
      expect((await (await page.request.head(`${origin}${prefix}/`)).body()).length).toBe(0);
      const deleted = await page.request.delete(`${origin}${prefix}/echo`);
      expect(deleted.status()).toBe(204);
      expect((await deleted.body()).length).toBe(0);
      expect(deleted.headers()["access-control-allow-credentials"]).toBeUndefined();
      revision = "replacement";
      expect((await page.request.get(`${origin}${prefix}/`)).status()).toBe(404);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
  30_000,
);
