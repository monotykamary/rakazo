import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ARTIFACTS = path.join(ROOT, ".artifacts");
const EMAIL = "preview@example.test";
const PASSWORD = "preview-only-password";

export function localPreviewDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("The preview requires a local PostgreSQL server; no remote database is used.");
  }
  if ([...url.searchParams].some(([key, value]) => key !== "schema" || value !== "public")) {
    throw new Error("The preview database URL must not contain connection query overrides.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = "/postgres";
  return url;
}

export function previewPort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Preview ports must be integers between 1024 and 65535.");
  }
  return port;
}

export function previewScript(
  prompt: string,
  script?: AgentRunRequest["script"],
): AgentRunRequest["script"] {
  // Fixture replies must not echo the private orchestration envelope into screenshots.
  return prompt.startsWith("[bot]")
    ? [{ assistant: "The Atlas review is ready.", complete: true }]
    : script;
}
async function main() {
  const apiPort = previewPort(process.env.API_PORT, 3219);
  const webPort = previewPort(process.env.WEB_PORT, 5294);
  if (apiPort === webPort) throw new Error("API_PORT and WEB_PORT must be different.");
  const origin = `http://127.0.0.1:${webPort}`;
  const previewToken = randomUUID();
  const lifecycle = new AbortController();
  const databaseName = `rakazo_preview_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const dataDir = path.join(ARTIFACTS, databaseName);
  await mkdir(dataDir, { recursive: true });

  let stopContainer: (() => Promise<unknown>) | undefined;
  let pool: import("@rakazo/db").Pool | undefined;
  let databaseCreated = false;
  let ownsMetadata = false;
  let web: ChildProcess | undefined;
  let webProcessGroup: number | undefined;
  let stopApp: (() => Promise<void>) | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  let stopping = false;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    lifecycle.abort();
    finish();
  };
  // Keep these listeners through cleanup so exit hooks cannot re-raise the signal.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    let databaseUrl: URL;
    if (process.env.DATABASE_URL) {
      databaseUrl = localPreviewDatabaseUrl(process.env.DATABASE_URL);
    } else {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer("postgres:16-alpine").start();
      stopContainer = () => container.stop();
      databaseUrl = localPreviewDatabaseUrl(container.getConnectionUri());
    }
    const adminDatabaseUrl = databaseUrl.toString();
    databaseUrl.pathname = `/${databaseName}`;
    const previewEnv = {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl.toString(),
      REALTIME_DATABASE_URL: databaseUrl.toString(),
      VERIFY_DATABASE: "1",
      WAKEUP_DRIVER: "memory",
      SANDBOX_PROVIDER: "fake",
      AGENT_RUNTIME: "scripted",
      CLOUD_AGENT_PROVIDER: "emulator",
      CURSOR_API_KEY: "",
      COMPOSIO_API_KEY: "",
      OPENROUTER_API_KEY: "",
      MODEL_API_KEY: "",
      BETTER_AUTH_SECRET: "preview-auth-secret-for-local-fixtures-only",
      ENCRYPTION_KEY: "preview-encryption-key-for-local-fixtures-only",
      SANDBOX_SUPERVISOR_TOKEN: "preview-supervisor-token-for-local-fixtures-only",
      SCREEN_PROXY_SECRET: "preview-screen-secret-for-local-fixtures-only",
      BETTER_AUTH_URL: origin,
      WEB_ORIGIN: origin,
      API_PORT: String(apiPort),
      API_HOST: "127.0.0.1",
      API_URL: `http://127.0.0.1:${apiPort}`,
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      WEB_PORT: String(webPort),
      RAKAZO_DESKTOP_STACK_TOKEN: previewToken,
      RAKAZO_IMAGE_TAG: "ux-preview",
      DATA_DIR: dataDir,
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      VITE_DEFAULT_UI_LOCALE: "en",
      CI: "1",
    };
    Object.assign(process.env, previewEnv);
    execFileSync("bun", ["run", "--cwd", "packages/db", "generate"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    // Generate before importing the database package, so no stale client is cached.
    const { createDb } = await import("@rakazo/db");
    pool = createDb(adminDatabaseUrl).pool;
    // Only this randomly named database is migrated or removed, never the input database.
    await pool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    execFileSync("bun", ["x", "--no-install", "prisma", "migrate", "deploy"], {
      cwd: path.join(ROOT, "packages/db"),
      stdio: "inherit",
    });
    const [
      {
        ComposioEmulator,
        EmailEmulator,
        PipedreamConnector,
        ScriptedAgentRuntime,
        ThirdPartyConnectorEmulator,
      },
      { createApp },
      { serve },
      { COORDINATOR_INSTRUCTIONS },
      { sessionCookieHeader },
      { loadEnv },
    ] = await Promise.all([
      import("@rakazo/adapters"),
      import("../../../../apps/api/src/app.ts"),
      import("@hono/node-server"),
      import("@rakazo/core"),
      import("../index.js"),
      import("../../../../apps/api/src/env.ts"),
    ]);
    const thirdParties = new ThirdPartyConnectorEmulator();
    const scripted = new ScriptedAgentRuntime();
    const handles = await createApp({
      ...loadEnv(previewEnv),
      runtime: {
        describe: () => scripted.describe(),
        abort: (runId) => scripted.abort(runId),
        run: (request, context) =>
          scripted.run(
            { ...request, script: previewScript(request.prompt, request.script) },
            context,
          ),
      },
      composio: new ComposioEmulator(),
      email: new EmailEmulator(),
      pipedream: new PipedreamConnector(
        {
          clientId: "fake-client-id",
          clientSecret: "fake-client-secret",
          projectId: "fake-project-id",
          environment: "development",
          identitySecret: process.env.ENCRYPTION_KEY,
        },
        { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
      ),
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      integrationsCatalogUrl: "https://catalog.example.test/",
    });
    stopApp = () => handles.stop();
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Preview User" }),
    });
    if (!signup.ok) throw new Error(`Preview signup failed (${signup.status})`);
    const cookie = sessionCookieHeader(signup);
    if (!cookie) throw new Error("Preview signup did not create a session");
    const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json: input }),
      });
      if (!response.ok) throw new Error(`Preview ${procedure} failed (${response.status})`);
      return ((await response.json()) as { json: T }).json;
    };
    const chief = await rpc<{ id: string }>("bots/create", {
      name: "Chief",
      title: "Builder and coordinator",
      description: "",
      instructions: COORDINATOR_INSTRUCTIONS,
      notifyOnFinish: true,
    });
    await rpc("onboarding/start", { botId: chief.id });

    const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: apiPort });
    server.once("error", (error) => {
      console.error(error);
      process.exitCode = 1;
      stop();
    });
    stopServer = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    web = spawn(
      "bun",
      ["run", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      {
        cwd: path.join(ROOT, "apps/web"),
        stdio: "inherit",
        detached: process.platform !== "win32",
      },
    );
    webProcessGroup = web.pid;
    web.once("error", (error) => {
      console.error(error);
      process.exitCode = 1;
      stop();
    });
    web.once("exit", (code) => {
      web = undefined;
      if (!stopping) {
        process.exitCode = code || 1;
        stop();
      }
    });
    if (!(await waitForPreviewServer(origin, previewToken, lifecycle.signal))) return;
    await writeFile(
      path.join(ARTIFACTS, "preview.json"),
      `${JSON.stringify({ url: `${origin}/app/${chief.id}`, origin, apiPort, botId: chief.id, email: EMAIL, password: PASSWORD, pid: process.pid, fixture: true }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    ownsMetadata = true;
    console.log(`Preview ready at ${origin}. Synthetic data; external services are emulated.`);
    console.log(`Sign in with ${EMAIL} / ${PASSWORD}. Stop with Ctrl+C.`);
    await stopped;
  } finally {
    stopping = true;
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => unknown | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await cleanup(() => {
      if (webProcessGroup) {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/pid", String(webProcessGroup), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          try {
            process.kill(-webProcessGroup, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
    });
    await cleanup(() => stopServer?.());
    await cleanup(() => stopApp?.());
    if (databaseCreated && pool) {
      const admin = pool;
      await cleanup(() => admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`));
    }
    await cleanup(() => pool?.end());
    await cleanup(() => stopContainer?.());
    await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    if (ownsMetadata) {
      await cleanup(() => rm(path.join(ARTIFACTS, "preview.json"), { force: true }));
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (cleanupErrors.length) {
      console.error(new AggregateError(cleanupErrors, "Preview cleanup failed"));
      process.exitCode = 1;
    }
  }
}

export async function waitForPreviewServer(origin: string, token: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (signal.aborted) return false;
    try {
      const response = await fetch(`${origin}/.well-known/rakazo-desktop-stack`, {
        headers: { "x-rakazo-desktop-stack-token": token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean; imageTag?: string };
        if (body.ok === true && body.imageTag === "ux-preview") return true;
      }
    } catch {
      // An unrelated server or a compiling Vite instance is not readiness evidence.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The preview web server did not become ready");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
