import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  ComposioEmulator,
  EmailEmulator,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import { createThreadMessage, type PrismaClient } from "@rakazo/db";
import { sessionCookieHeader } from "../index.js";
import { runProcess } from "./process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPORT_DIR = path.join(ROOT, "test-report", "mobile-screenshots");
const DATA_DIR = path.join(ROOT, ".tmp", "mobile-screenshots-data");
const FLOW = path.join(ROOT, "apps", "mobile", ".maestro", "screenshots.yaml");
const EMAIL = "mobile-screenshots@example.test";
const PASSWORD = "test-password-123";
const API_PORT = 3110;
const HOST_API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_ORIGIN = "http://127.0.0.1:5180";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

async function main() {
  process.chdir(ROOT);
  // Recording is never part of the default screenshot run. Use a disposable emulator only.
  const notificationDemo = process.env.RAKAZO_NOTIFICATION_DEMO === "1";
  const serial = process.env.ANDROID_SERIAL ?? "";
  if (notificationDemo && !/^emulator-\d+$/.test(serial)) {
    throw new Error("Notification demos require ANDROID_SERIAL for a dedicated emulator");
  }
  configureEnvironment();
  await rm(REPORT_DIR, { recursive: true, force: true });
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  execFileSync("bun", ["run", "prisma", "migrate", "deploy"], {
    cwd: path.join(ROOT, "packages", "db"),
    env: process.env,
    stdio: "inherit",
  });
  const thirdParties = new ThirdPartyConnectorEmulator();
  const pipedream = new PipedreamConnector(
    {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: process.env.ENCRYPTION_KEY!,
    },
    { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
  );
  const { createApp } = await import("../../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir: DATA_DIR,
    apiHost: "0.0.0.0",
    apiUrl: HOST_API_URL,
    composio: new ComposioEmulator(),
    pipedream,
    email: new EmailEmulator(),
    remoteConnectors: {
      fetch: thirdParties.fetch,
      resolveHostname: thirdParties.resolveHostname,
    },
  });

  const fixture = await seedFixture(handles.app, handles.prisma);
  const server = serve({
    fetch: handles.app.fetch,
    hostname: "0.0.0.0",
    port: API_PORT,
  });

  let deviceControl: Server | undefined;
  try {
    await waitForHealth(`${HOST_API_URL}/health`, 15_000);
    await runProcess(
      "maestro",
      [
        "test",
        "--no-ansi",
        "--flatten-debug-output",
        "--debug-output",
        path.join(REPORT_DIR, "debug"),
        "--test-output-dir",
        REPORT_DIR,
        "--format",
        "HTML",
        "--output",
        path.join(REPORT_DIR, "report.html"),
        "-e",
        `RAKAZO_SCREENSHOT_EMAIL=${EMAIL}`,
        "-e",
        `RAKAZO_SCREENSHOT_PASSWORD=${PASSWORD}`,
        "-e",
        `RAKAZO_SCREENSHOT_BOT_ID=${fixture.botId}`,
        "-e",
        `RAKAZO_SCREENSHOT_GROUP_ID=${fixture.groupId}`,
        "-e",
        `RAKAZO_SCREENSHOT_ROUTINE_ID=${fixture.routineId}`,
        FLOW,
      ],
      process.env,
    );
    if (notificationDemo) {
      const control = await startDeviceControlServer(serial);
      deviceControl = control.server;
      await runProcess(
        "maestro",
        [
          "--device",
          serial,
          "test",
          "--no-ansi",
          "--flatten-debug-output",
          "--debug-output",
          path.join(REPORT_DIR, "debug", "notification-demo"),
          "--test-output-dir",
          path.join(REPORT_DIR, "notification-demo"),
          "--format",
          "HTML",
          "--output",
          path.join(REPORT_DIR, "notification-demo.html"),
          "-e",
          `RAKAZO_SCREENSHOT_EMAIL=${EMAIL}`,
          "-e",
          `RAKAZO_SCREENSHOT_PASSWORD=${PASSWORD}`,
          "-e",
          `RAKAZO_SCREENSHOT_BOT_ID=${fixture.botId}`,
          "-e",
          `RAKAZO_NOTIFICATION_VIDEO=${path.join(REPORT_DIR, "notification-demo")}`,
          "-e",
          `RAKAZO_EXPAND_NOTIFICATIONS_URL=${control.url}`,
          path.join(ROOT, "apps", "mobile", ".maestro", "notification-demo.yaml"),
        ],
        process.env,
      );
    }
    await writeFile(
      path.join(REPORT_DIR, "summary.json"),
      `${JSON.stringify({ ok: true }, null, 2)}\n`,
    );
  } finally {
    if (deviceControl) {
      deviceControl.closeAllConnections();
      await new Promise<void>((resolve) => deviceControl!.close(() => resolve()));
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await handles.stop().catch(() => undefined);
    await rm(DATA_DIR, { recursive: true, force: true });
  }
}

/** Host-only, per-run capability; never accept a command or device from a request. */
export async function startDeviceControlServer(
  serial: string,
): Promise<{ server: Server; url: string }> {
  if (!/^emulator-\d+$/.test(serial)) throw new Error("A dedicated emulator serial is required");
  const route = `/expand-notifications/${randomUUID()}`;
  let busy = false;
  let command: ReturnType<typeof execFile> | undefined;
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET" || req.url !== route || req.headers.origin) {
      res.writeHead(404).end();
      return;
    }
    if (busy) {
      res.writeHead(429).end();
      return;
    }
    busy = true;
    command = execFile(
      "adb",
      ["-s", serial, "shell", "cmd", "statusbar", "expand-notifications"],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      (error) => {
        busy = false;
        command = undefined;
        if (res.destroyed) return;
        res.writeHead(error ? 500 : 200, { "content-type": "text/plain; charset=utf-8" });
        res.end(error ? "Could not expand notifications" : "ok");
      },
    );
  });
  server.once("close", () => {
    if (busy) command?.kill();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Device control did not bind");
  return { server, url: `http://127.0.0.1:${address.port}${route}` };
}

function configureEnvironment() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the isolated mobile screenshot fixture");
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    COMPOSIO_API_KEY: "",
    BETTER_AUTH_SECRET: "mobile-screenshot-auth-secret-32chars",
    ENCRYPTION_KEY: "mobile-screenshot-encryption-key-32chars",
    SCREEN_PROXY_SECRET: "mobile-screenshot-screen-secret-32chars",
    BETTER_AUTH_URL: HOST_API_URL,
    WEB_ORIGIN,
    API_HOST: "0.0.0.0",
    API_PORT: String(API_PORT),
    API_URL: HOST_API_URL,
    DATA_DIR,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    CI: "1",
  });
}

async function seedFixture(app: App, prisma: PrismaClient) {
  const cookie = await signup(app);
  const researcher = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Researcher",
    title: "Product research",
    description: "Finds evidence and keeps fixture notes organized.",
    instructions: "Find evidence and summarize it clearly.",
    notifyOnFinish: true,
  });
  const writer = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Writer",
    title: "Clear writing",
    description: "Turns research into concise drafts.",
    instructions: "Write concise drafts from the available evidence.",
    notifyOnFinish: true,
  });
  const support = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Support",
    title: "Customer support",
    description: "Prepares friendly customer replies.",
    instructions: "Prepare accurate and friendly customer replies.",
    notifyOnFinish: false,
  });
  const archived = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Archived fixture",
    title: "Archived",
    description: "A recoverable archived bot for account screenshots.",
    instructions: "Remain archived.",
    notifyOnFinish: true,
  });
  await rpc(app, cookie, "bots/archive", { botId: archived.id });

  const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
    name: "Launch team",
    botIds: [researcher.id, writer.id, support.id],
  });
  const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
    botId: researcher.id,
    name: "Weekly fixture review",
    prompt: "Review the fixture launch notes and summarize the open questions.",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    active: true,
    notify: true,
  });

  const botThread = await prisma.thread.findUniqueOrThrow({ where: { botId: researcher.id } });
  const groupThread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
  const question = await createThreadMessage(prisma, {
    threadId: botThread.id,
    role: "user",
    blocks: [{ kind: "text", text: "Summarize the fixture launch checklist." }],
  });
  await createThreadMessage(prisma, {
    threadId: botThread.id,
    role: "bot",
    botId: researcher.id,
    blocks: [{ kind: "text", text: "The fixture workspace is ready." }],
  });
  await createThreadMessage(prisma, {
    threadId: groupThread.id,
    role: "user",
    blocks: [{ kind: "text", text: "Coordinate the fixture launch plan." }],
  });
  await createThreadMessage(prisma, {
    threadId: groupThread.id,
    role: "bot",
    botId: writer.id,
    blocks: [{ kind: "text", text: "The fixture launch plan is ready." }],
  });

  const task = await prisma.task.create({
    data: {
      spaceId: botThread.spaceId,
      userId: botThread.userId,
      botId: researcher.id,
      threadId: botThread.id,
      prompt: "Prepare the fixture workspace",
      status: "completed",
    },
  });
  await prisma.run.create({
    data: {
      spaceId: botThread.spaceId,
      userId: botThread.userId,
      botId: researcher.id,
      threadId: botThread.id,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: question.id,
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });

  return { botId: researcher.id, groupId: group.id, routineId: routine.id };
}

async function signup(app: App) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Screenshot User" }),
  });
  if (!response.ok) throw new Error(`Fixture signup failed with ${response.status}`);
  const cookie = sessionCookieHeader(response);
  if (!cookie) throw new Error("Fixture signup did not return a session cookie");
  return cookie;
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: WEB_ORIGIN,
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function waitForHealth(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "no response";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Mobile screenshot API did not become ready: ${lastError}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
