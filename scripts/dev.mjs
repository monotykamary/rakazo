#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { ensureWorker, workerControl } from "./dev-worker.mjs";

class DevError extends Error {}

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PI_RUNTIME_VERSION = JSON.parse(
  await readFile(path.join(checkout, "packages/pi-kit/package.json"), "utf8"),
).dependencies["@earendil-works/pi-coding-agent"];
export function validatePiVersion(output) {
  const version = output.trim().match(/^(?:pi\s+)?(\d+)\.(\d+)\.(\d+)$/);
  const minimum = PI_RUNTIME_VERSION.split(".").map(Number);
  if (
    !version ||
    Number(version[1]) !== minimum[0] ||
    Number(version[2]) < minimum[1] ||
    (Number(version[2]) === minimum[1] && Number(version[3]) < minimum[2])
  ) {
    throw new DevError(
      `Pi ${PI_RUNTIME_VERSION} or a newer compatible 0.x release is required (agent_settled). Run bun run dev:kit for an isolated pinned install, then set RAKAZO_PI_COMMAND=data/dev/pi/node_modules/.bin/pi. Existing Pi was not changed.`,
    );
  }
  return version.slice(1).join(".");
}

export const flags = new Set([
  "--trust-local-pi",
  "--install-pi",
  "--install-kit",
  "--setup-kit",
  "--pi",
  "--help",
]);
export function options(args) {
  for (const arg of args) if (!flags.has(arg)) throw new DevError(`Unknown dev option: ${arg}`);
  return new Set(args);
}

export async function consent(
  message,
  enabled,
  { input = process.stdin, output = process.stdout } = {},
) {
  if (enabled) return true;
  if (!input.isTTY || !output.isTTY) return false;
  const prompt = createInterface({ input, output });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${message} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

export function trustedEnvironment(env) {
  return env.AGENT_RUNTIME === "pi-local" && env.RAKAZO_TRUST_LOCAL_PI === "1";
}

export function defaults(root, env, fresh, secret = () => randomBytes(32).toString("hex")) {
  const password = secret();
  const values = {
    NODE_ENV: "development",
    ...(fresh
      ? {
          BETTER_AUTH_SECRET: secret(),
          ENCRYPTION_KEY: secret(),
          SCREEN_PROXY_SECRET: secret(),
          SANDBOX_SUPERVISOR_TOKEN: secret(),
        }
      : {}),
    BETTER_AUTH_URL: "http://127.0.0.1:5173",
    API_URL: "http://127.0.0.1:3100",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    SIGNUPS_ENABLED: "true",
    DATA_DIR: path.join(root, "data"),
    SANDBOX_PROVIDER: "desktop",
    SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
    WAKEUP_DRIVER: "graphile",
    CLOUD_AGENT_PROVIDER: "none",
  };
  // Only a new checkout owns a database. Existing URLs always remain external.
  if (fresh && !env.DATABASE_URL) {
    values.DATABASE_URL = `postgres://rakazo:${password}@127.0.0.1:5433/rakazo`;
    values.RAKAZO_DEV_DATABASE = "1";
  }
  return Object.fromEntries(Object.entries(values).filter(([key]) => env[key] === undefined));
}

// Bind checks never connect to or stop an existing service.
export async function availablePort(port, host = "127.0.0.1") {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      const selected = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

export async function environmentAdditions(root, values, fresh, prefer = 5433) {
  const additions = defaults(root, values, fresh);
  if (additions.DATABASE_URL) {
    let port;
    try {
      port = await availablePort(prefer);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      port = await availablePort(0);
    }
    const url = new URL(additions.DATABASE_URL);
    url.port = String(port);
    additions.DATABASE_URL = url.href;
  }
  return additions;
}

export function validateSecrets(env) {
  const seen = new Set();
  for (const key of [
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "SCREEN_PROXY_SECRET",
    "SANDBOX_SUPERVISOR_TOKEN",
  ]) {
    const value = env[key]?.trim();
    if (!value || value.length < 32 || /^(replace-with-|dev-.*(?:secret|token|key))/.test(value)) {
      throw new DevError(
        `${key} is missing, short or a placeholder. Restore or explicitly configure the existing secret; dev will not rotate keys or use development placeholders.`,
      );
    }
    if (seen.has(value))
      throw new DevError(`${key} must be independent of other application secrets`);
    seen.add(value);
  }
}

export async function readEnvironment(root) {
  const filename = path.join(root, ".env");
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DevError(".env must be a regular file");
    return { text: await readFile(filename, "utf8"), fresh: false };
  } catch (error) {
    if (error.code === "ENOENT") return { text: "", fresh: true };
    throw error;
  }
}

export async function loadEnvironment(root, inherited = process.env) {
  const snapshot = await readEnvironment(root);
  const stored = parseEnv(snapshot.text);
  return { snapshot, stored, values: { ...stored, ...inherited } };
}

export async function saveEnvironment(root, snapshot, additions) {
  const filename = path.join(root, ".env");
  const handle = await open(
    filename,
    snapshot.fresh ? "wx" : constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!snapshot.fresh && (await handle.readFile("utf8")) !== snapshot.text)
      throw new DevError(".env changed during startup; retry");
    await handle.chmod(0o600);
    const body = Object.entries(additions)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n");
    if (body)
      await handle.write(`${snapshot.text && !snapshot.text.endsWith("\n") ? "\n" : ""}${body}\n`);
  } finally {
    await handle.close();
  }
}

export function runtimeEnvironment(root, values, command) {
  if (values.RAKAZO_PI_CWD && !path.isAbsolute(values.RAKAZO_PI_CWD))
    throw new DevError("RAKAZO_PI_CWD must be absolute");
  return {
    ...values,
    AGENT_RUNTIME: "pi-local",
    RAKAZO_TRUST_LOCAL_PI: "1",
    RAKAZO_PI_COMMAND: command,
    RAKAZO_PI_CWD: values.RAKAZO_PI_CWD || root,
    SANDBOX_PROVIDER: "desktop",
    DATA_DIR: path.resolve(root, values.DATA_DIR || "data"),
  };
}

export function databasePlan(root, env) {
  if (!env.DATABASE_URL)
    throw new DevError("Set DATABASE_URL for the existing checkout; no database was changed");
  if (env.RAKAZO_DEV_DATABASE !== "1") return null;
  const url = new URL(env.DATABASE_URL);
  if (
    url.hostname !== "127.0.0.1" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.port ||
    !url.password ||
    url.search ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)
  ) {
    throw new DevError(
      "Managed dev database requires a loopback Postgres URL with a password and explicit port",
    );
  }
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const name = `rakazo-dev-${id}-postgres`;
  const volume = `${name}-data`;
  const pgdata = "/var/lib/postgresql/data/pgdata";
  const envFile = path.join(env.DATA_DIR, "dev", "postgres.env");
  const user = decodeURIComponent(url.username);
  const database = url.pathname.slice(1);
  const password = decodeURIComponent(url.password);
  if (![user, database, password].every((value) => value && !/[\r\n\0]/.test(value)))
    throw new DevError("Invalid managed database credentials");
  const configId = createHash("sha256")
    .update(JSON.stringify([volume, pgdata, url.port, user, database, "postgres:16"]))
    .digest("hex");
  return {
    configId,
    volume,
    volumeInspect: ["volume", "inspect", volume],
    volumeCreate: ["volume", "create", volume],
    name,
    envFile,
    credentials: `POSTGRES_USER=${user}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${database}\n`,
    inspect: ["inspect", "--type", "container", name],
    start: ["start", name],
    bindDir: path.join(env.DATA_DIR, "dev", "postgres"),
    run: [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `dev.rakazo.checkout=${id}`,
      "--label",
      `dev.rakazo.config=${configId}`,
      "--env-file",
      envFile,
      "--publish",
      `127.0.0.1:${url.port}:5432`,
      "--volume",
      `${volume}:/var/lib/postgresql/data`,
      "--env",
      `PGDATA=${pgdata}`,
      "postgres:16",
    ],
    ready: ["exec", name, "pg_isready", "-U", user, "-d", database],
    id,
  };
}

export async function waitFor(
  probe,
  { attempts = 60, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal } = {},
) {
  for (let i = 0; i < attempts; i++) {
    signal?.throwIfAborted();
    if (await probe()) return;
    if (i + 1 < attempts) await delay(1000);
  }
  throw new DevError("Readiness timed out");
}

export function processes(root, env) {
  const children = new Map();
  let closing = false;
  let cleanupPromise;
  const kill = (child, signal) => {
    if (!child.pid) return;
    try {
      if (children.get(child)?.group) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  function launch(
    command,
    args,
    {
      capture = false,
      timeout = 0,
      cwd = root,
      environment = env,
      interactive = false,
      onOutput,
    } = {},
  ) {
    if (closing) throw new DevError("Startup cancelled");
    const child = spawn(command, args, {
      cwd,
      env: environment,
      detached: !interactive,
      stdio: interactive
        ? "inherit"
        : ["ignore", capture || onOutput ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    const record = { group: !interactive, done: undefined };
    children.set(child, record);
    let output = "";
    if (capture || onOutput)
      child.stdout.on("data", (chunk) => {
        if (capture && output.length < 1024 * 1024) output += chunk;
        if (onOutput) {
          process.stdout.write(chunk);
          onOutput(chunk.toString());
        }
      });
    // Captured stderr can contain credentials; deliberately do not surface it.
    if (capture) child.stderr.resume();
    const timer = timeout ? setTimeout(() => kill(child, "SIGKILL"), timeout) : undefined;
    const done = new Promise((resolve) => {
      child.once("error", () => resolve({ code: 1, output: "" }));
      child.once("close", (code) => resolve({ code: code ?? 1, output }));
    }).finally(() => {
      clearTimeout(timer);
      children.delete(child);
    });
    record.done = done;
    return { child, done };
  }
  async function run(command, args, settings = {}) {
    const result = await launch(command, args, { timeout: 120000, ...settings }).done;
    if (result.code !== 0 && !settings.allowFailure)
      throw new DevError(`${commandPhase(command, args)} failed (${result.code})`);
    return result;
  }
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    closing = true;
    cleanupPromise = (async () => {
      const active = [...children];
      for (const [child] of active) kill(child, "SIGTERM");
      const timer = setTimeout(() => {
        for (const [child] of active) if (children.has(child)) kill(child, "SIGKILL");
      }, 5000);
      try {
        await Promise.all(active.map(([, record]) => record.done));
      } finally {
        clearTimeout(timer);
      }
    })();
    return cleanupPromise;
  }
  return { run, launch, cleanup };
}

export function commandPhase(command, args) {
  const name = path.basename(command);
  // Only fixed CLI verbs are safe: never include names, paths, URLs or exec arguments.
  if (name === "mocker") {
    if (args[0] === "volume" && ["inspect", "create"].includes(args[1]))
      return `mocker volume ${args[1]}`;
    if (["inspect", "start", "run", "exec", "--version"].includes(args[0]))
      return `mocker ${args[0]}`;
  }
  return name;
}

export async function preflightServices(env) {
  for (const [index, url] of serviceUrls(env).entries()) {
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    try {
      await availablePort(port, index === 0 ? env.API_HOST || "127.0.0.1" : url.hostname);
    } catch {
      throw new DevError(
        `${index === 0 ? "API" : "Web"} listener port ${port} unavailable; stop the conflicting service or configure a different port`,
      );
    }
  }
}

export function serviceUrls(env) {
  const api = new URL("/health", env.API_URL || "http://127.0.0.1:3100");
  if (env.API_PORT) api.port = env.API_PORT;
  return [api, new URL("/", env.WEB_ORIGIN || "http://127.0.0.1:5173")];
}

export async function executable(command, env, root) {
  const candidates = command.includes("/")
    ? [path.resolve(root, command)]
    : (env.PATH || "").split(path.delimiter).map((dir) => path.resolve(root, dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await lstat(await realpath(candidate))).isFile()) return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}

export function piInstallPlan(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new DevError("Pi must have an exact reviewed version");
  const prefix = path.join(root, "data", "dev", "pi");
  return {
    prefix,
    command: path.join(prefix, "node_modules", ".bin", "pi"),
    args: [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `@earendil-works/pi-coding-agent@${version}`,
    ],
  };
}

export async function resolvePi(root, env, opts, runner) {
  const requested = env.RAKAZO_PI_COMMAND || "pi";
  const found = await executable(requested, env, root);
  if (found && !opts.has("--setup-kit")) {
    if (opts.has("--install-kit"))
      throw new DevError(
        "Existing Pi is untouched; install kit packages explicitly in your Pi configuration instead",
      );
    if (found === path.join(root, "data/dev/pi/node_modules/.bin/pi")) {
      const profile = path.join(root, "data/dev/pi/agent");
      try {
        await access(path.join(profile, "settings.json"));
        env.PI_CODING_AGENT_DIR ??= profile;
      } catch {
        /* No isolated kit was installed. */
      }
    }
    return found;
  }
  if (env.RAKAZO_PI_COMMAND && !opts.has("--setup-kit"))
    throw new DevError("RAKAZO_PI_COMMAND is not executable; fix the override");
  const pkg = JSON.parse(await readFile(path.join(root, "packages/pi-kit/package.json"), "utf8"));
  const plan = piInstallPlan(root, pkg.dependencies["@earendil-works/pi-coding-agent"]);
  let installed = false;
  if (!(await executable(plan.command, env, root))) {
    if (
      !(await consent(
        "Pi is absent. Install the reviewed pinned Pi locally (no global changes)?",
        opts.has("--install-pi"),
      ))
    ) {
      throw new DevError("Install Pi or retry with --install-pi");
    }
    await runner.run("npm", plan.args, { capture: true });
    installed = true;
  }
  if (
    opts.has("--install-kit") ||
    (installed &&
      (await consent("Install reviewed kit packages into an isolated local Pi profile?", false)))
  ) {
    const agentDir = path.join(plan.prefix, "agent");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const manifest = JSON.parse(
      await readFile(path.join(root, "vendor/pi-kit/manifest.json"), "utf8"),
    );
    const settingsFile = path.join(agentDir, "settings.json");
    let settings = {};
    try {
      settings = JSON.parse(await readFile(settingsFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const pkg of manifest.packages) {
      // Identity by npm name avoids duplicating or replacing an existing configured version.
      if (
        (settings.packages || []).some((entry) =>
          (typeof entry === "string" ? entry : entry.source)?.startsWith(`npm:${pkg.name}@`),
        )
      )
        continue;
      const directory = path.join(plan.prefix, "kit", "node_modules", pkg.name);
      if (
        (settings.packages || []).some(
          (entry) => (typeof entry === "string" ? entry : entry.source) === directory,
        )
      )
        continue;
      const archive = path.join(root, "vendor/pi-kit", pkg.filename);
      if (
        createHash("sha256")
          .update(await readFile(archive))
          .digest("hex") !== pkg.sha256
      )
        throw new DevError("Vendored kit integrity check failed");
      // Install the reviewed local archive, not a potentially different registry tarball.
      await runner.run(
        "npm",
        [
          "install",
          "--prefix",
          path.join(plan.prefix, "kit"),
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          archive,
        ],
        { capture: true },
      );
      await runner.run(plan.command, ["install", directory], {
        capture: true,
        cwd: plan.prefix,
        environment: { ...env, PI_CODING_AGENT_DIR: agentDir },
      });
      settings = JSON.parse(await readFile(settingsFile, "utf8"));
    }
    env.PI_CODING_AGENT_DIR ??= agentDir;
  } else {
    // Reuse the isolated profile on subsequent boots, if one was installed previously.
    try {
      await access(path.join(plan.prefix, "agent/settings.json"));
      env.PI_CODING_AGENT_DIR ??= path.join(plan.prefix, "agent");
    } catch {
      /* Keep the user's existing Pi profile. */
    }
  }
  return plan.command;
}

export function interactivePiEnvironment(inherited, stored = {}) {
  // Do not copy application credentials from .env into the interactive Pi profile.
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(RAKAZO_|BETTER_AUTH_|DATABASE_URL$|ENCRYPTION_KEY$|SCREEN_PROXY_|SANDBOX_)/.test(key))
      delete env[key];
  }
  for (const key of ["RAKAZO_PI_COMMAND", "RAKAZO_PI_CWD", "PI_CODING_AGENT_DIR"]) {
    const value = inherited[key] || stored[key];
    if (value) env[key] = value;
  }
  if (env.RAKAZO_PI_CWD && !path.isAbsolute(env.RAKAZO_PI_CWD))
    throw new DevError("RAKAZO_PI_CWD must be absolute");
  return env;
}

export async function ensureDatabase(plan, runner, signal) {
  const inspect = await runner.run("mocker", plan.inspect, { capture: true, allowFailure: true });
  let container;
  if (inspect.code === 0) {
    const parsed = JSON.parse(inspect.output);
    container = Array.isArray(parsed) ? parsed[0] : parsed;
    if (container?.Config?.Labels?.["dev.rakazo.checkout"] !== plan.id)
      throw new DevError("Database container ownership mismatch; nothing was changed");
    // Mocker preserves labels, but does not expose mounts.
    if (container.Config.Labels["dev.rakazo.config"] !== plan.configId)
      throw new DevError("Database container configuration mismatch; nothing was changed");
  }
  const marker = path.join(plan.bindDir, "owner");
  let ownership;
  let directoryExists = false;
  try {
    const directory = await lstat(plan.bindDir);
    directoryExists = true;
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
      throw new Error("invalid directory");
    const owner = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await owner.stat();
      if (!stat.isFile() || stat.mode & 0o077) throw new Error("invalid marker");
      ownership = JSON.parse(await owner.readFile("utf8"));
      if (
        ownership.checkout !== plan.id ||
        ownership.volume !== plan.volume ||
        !["pending", "ready"].includes(ownership.state)
      )
        throw new Error("invalid marker");
    } finally {
      await owner.close();
    }
  } catch (error) {
    if (directoryExists || error.code !== "ENOENT")
      throw new DevError("Database volume ownership mismatch; nothing was changed");
  }
  const volumeExists = async () => {
    const result = await runner.run("mocker", plan.volumeInspect, {
      capture: true,
      allowFailure: true,
    });
    if (result.code !== 0) return false;
    const volume = JSON.parse(result.output);
    if (volume?.name !== plan.volume)
      throw new DevError("Database volume ownership mismatch; nothing was changed");
    return true;
  };
  const exists = await volumeExists();
  if (exists && !ownership)
    throw new DevError("Database volume ownership mismatch; nothing was changed");
  if (!exists && (ownership?.state === "ready" || container))
    throw new DevError("Previously owned database volume is missing; nothing was changed");
  if (!ownership) {
    await mkdir(path.dirname(plan.bindDir), { recursive: true, mode: 0o700 });
    await mkdir(plan.bindDir, { mode: 0o700 });
    ownership = { checkout: plan.id, volume: plan.volume, state: "pending" };
    const owner = await open(marker, "wx", 0o600);
    try {
      await owner.writeFile(JSON.stringify(ownership));
      await owner.sync();
    } finally {
      await owner.close();
    }
  }
  if (!exists) {
    await runner.run("mocker", plan.volumeCreate, { capture: true });
    if (!(await volumeExists()))
      throw new DevError("Database volume creation could not be verified");
  }
  if (ownership.state === "pending") {
    const owner = await open(marker, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await owner.writeFile(JSON.stringify({ ...ownership, state: "ready" }));
      await owner.truncate(Buffer.byteLength(JSON.stringify({ ...ownership, state: "ready" })));
      await owner.sync();
    } finally {
      await owner.close();
    }
  }
  const handle = await open(
    plan.envFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(plan.credentials);
  } finally {
    await handle.close();
  }
  if (container) {
    const state = container.State ?? container.state;
    if (!(state?.Running === true || state?.Status === "running"))
      await runner.run("mocker", plan.start, { capture: true });
  } else {
    await runner.run("mocker", plan.run, { capture: true });
  }
  await waitFor(
    async () =>
      (await runner.run("mocker", plan.ready, { capture: true, allowFailure: true, timeout: 5000 }))
        .code === 0,
    { signal: signal },
  );
}

// Call only after database authentication; status failures must not reclaim a worker.
export async function prepareWorkerDatabase({ root, env, runner, control = workerControl }) {
  const { state } = await control({ root, env }, "status");
  if (state !== "stopped") {
    let status;
    try {
      status = await runner.run(
        "bun",
        ["run", "--cwd", "packages/db", "prisma", "migrate", "status"],
        { allowFailure: true, capture: true },
      );
    } catch {
      // A failed read-only check is not permission to migrate under active work.
    }
    if (status?.code !== 0)
      throw new DevError(
        "Migrations are not verified up to date while a worker exists. Run node scripts/dev-worker.mjs stop, wait until node scripts/dev-worker.mjs status reports stopped, then run bun dev. Nothing was stopped.",
      );
  }
  await runner.run("bun", ["run", "db:generate"]);
  if (state === "stopped") await runner.run("bun", ["run", "db:migrate"], { capture: true });
}

export async function bootstrap({
  root = checkout,
  inherited = process.env,
  args = process.argv.slice(2),
} = {}) {
  const opts = options(args);
  if (opts.has("--help")) {
    console.log(
      "bun run dev [--trust-local-pi] [--install-pi] [--install-kit]\nbun run dev:pi (or --pi): open Pi for /login and /model\nbun run dev:kit: isolated pinned Pi and kit setup, not authentication\nStarts web, API and worker from source; never Electron. Local Pi has host access.\nCtrl+C leaves the local worker and active tasks running. node scripts/dev-worker.mjs status|stop|restart controls it. Restart drains active work before reloading source; no automatic worker watch. Database volumes persist. Existing databases and Pi configuration are preserved.",
    );
    return;
  }
  root = await realpath(root);
  if (opts.has("--setup-kit") || opts.has("--pi")) {
    const stored = opts.has("--pi") ? parseEnv((await readEnvironment(root)).text) : {};
    const env = interactivePiEnvironment(inherited, stored);
    const runner = processes(root, env);
    let piOwnsTTY = false;
    const interrupt = () => {
      // Pi shares the foreground process group and handles Ctrl+C itself.
      if (!piOwnsTTY) stop();
    };
    const stop = () => {
      process.exitCode = 130;
      void runner.cleanup();
    };
    process.on("SIGINT", interrupt);
    process.once("SIGTERM", stop);
    try {
      const command = await resolvePi(root, env, opts, runner);
      validatePiVersion((await runner.run(command, ["--version"], { capture: true })).output);
      if (opts.has("--pi")) {
        console.log("Use /login and /model in Pi. Existing settings are preserved.");
        piOwnsTTY = true;
        try {
          const result = await runner.run(command, [], {
            timeout: 0,
            cwd: env.RAKAZO_PI_CWD || root,
            interactive: true,
            allowFailure: true,
          });
          process.exitCode ||= result.code;
        } finally {
          piOwnsTTY = false;
        }
      } else {
        console.log(
          "Isolated kit installed, not authenticated. Set RAKAZO_PI_COMMAND=data/dev/pi/node_modules/.bin/pi and run bun run dev:pi for /login and /model. Existing Pi settings are unchanged.",
        );
      }
    } finally {
      await runner.cleanup();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  const { snapshot, stored, values } = await loadEnvironment(root, inherited);
  if (values.NODE_ENV === "production" || values.RAKAZO_DEPLOY_DIR || values.RAKAZO_COMPOSE_FILE)
    throw new DevError("Refusing source dev startup in a managed deployment");
  if (
    (!trustedEnvironment(values) || values.SANDBOX_PROVIDER !== "desktop") &&
    !(await consent(
      "Trust local Pi with host commands, files and your existing Pi credentials?",
      opts.has("--trust-local-pi"),
    ))
  ) {
    throw new DevError("Local Pi requires explicit consent; retry with --trust-local-pi");
  }
  const additions = await environmentAdditions(root, values, snapshot.fresh);
  Object.assign(values, additions);
  validateSecrets(values);
  if (!values.DATABASE_URL)
    throw new DevError("Set DATABASE_URL before starting this existing checkout");
  const env = runtimeEnvironment(root, values, values.RAKAZO_PI_COMMAND || "pi");
  if (inherited.DATABASE_URL && inherited.DATABASE_URL !== stored.DATABASE_URL)
    env.RAKAZO_DEV_DATABASE = "0";
  const runner = processes(root, env);
  const abort = new AbortController();
  const interrupted = () => {
    abort.abort();
    void runner.cleanup();
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const bun = await runner.run("bun", ["--version"], { capture: true });
    if (`bun@${bun.output.trim()}` !== pkg.packageManager)
      throw new DevError(`Use the repository-pinned ${pkg.packageManager}`);
    env.RAKAZO_PI_COMMAND = await resolvePi(root, env, opts, runner);
    const piVersion = await runner.run(env.RAKAZO_PI_COMMAND, ["--version"], {
      capture: true,
      timeout: 15000,
    });
    validatePiVersion(piVersion.output);
    // Consent is durable only for a previously unconfigured runtime. Never rewrite managed values.
    if (!stored.AGENT_RUNTIME && !inherited.AGENT_RUNTIME) additions.AGENT_RUNTIME = "pi-local";
    if (
      !stored.RAKAZO_TRUST_LOCAL_PI &&
      !inherited.RAKAZO_TRUST_LOCAL_PI &&
      (!stored.AGENT_RUNTIME || stored.AGENT_RUNTIME === "pi-local")
    )
      additions.RAKAZO_TRUST_LOCAL_PI = "1";
    await saveEnvironment(root, snapshot, additions);
    await mkdir(path.join(env.DATA_DIR, "pi-sessions"), { recursive: true, mode: 0o700 });
    const plan = databasePlan(root, env);
    if (plan) {
      if (process.platform !== "darwin")
        throw new DevError(
          "Managed dev services require Apple container on macOS; use an external DATABASE_URL elsewhere",
        );
      await runner.run("mocker", ["--version"], { capture: true });
      const status = await runner.run("container", ["system", "status"], {
        capture: true,
        allowFailure: true,
      });
      if (status.code !== 0 || /not running|stopped/i.test(status.output))
        await runner.run("container", ["system", "start"]);
      await waitFor(
        async () =>
          (
            await runner.run("container", ["system", "status"], {
              capture: true,
              allowFailure: true,
            })
          ).code === 0,
        { signal: abort.signal },
      );
    }
    if (plan) await ensureDatabase(plan, runner, abort.signal);
    // Authenticate against the actual URL, including for external services; never migrate a merely open port.
    const require = createRequire(path.join(root, "packages/db/package.json"));
    const { Client } = require("pg");
    await waitFor(
      async () => {
        const client = new Client({
          connectionString: env.DATABASE_URL,
          connectionTimeoutMillis: 2000,
        });
        try {
          await client.connect();
          await client.query("SELECT 1");
          return true;
        } catch {
          return false;
        } finally {
          await client.end().catch(() => {});
        }
      },
      { signal: abort.signal },
    );
    await prepareWorkerDatabase({ root, env, runner });
    await preflightServices(env);
    await ensureWorker({ root, env });
    const service = runner.launch("bun", [
      "x",
      "turbo",
      "dev",
      "--env-mode=loose",
      "--filter=@rakazo/api",
      "--filter=@rakazo/web",
    ]);
    console.log(
      "Source services starting. Ctrl+C stops API/web; the worker and active tasks remain alive. Use node scripts/dev-worker.mjs stop to drain.",
    );
    const exited = service.done.then((result) => {
      throw new DevError(`Dev service exited (${result.code})`);
    });
    const readiness = new AbortController();
    try {
      await Promise.race([
        exited,
        waitFor(
          async () => {
            try {
              const results = await Promise.all(
                serviceUrls(env).map((url) =>
                  fetch(url, { signal: AbortSignal.timeout(2000) }).then((response) => {
                    void response.body?.cancel();
                    return response.ok;
                  }),
                ),
              );
              return (
                (await workerControl({ root, env })).state === "ready" && results.every(Boolean)
              );
            } catch {
              return false;
            }
          },
          { signal: AbortSignal.any([abort.signal, readiness.signal]) },
        ),
      ]);
    } finally {
      readiness.abort();
    }
    console.log("App ready. Run bun run dev:pi for Pi /login and /model if needed.");
    const result = await service.done;
    if (result.code !== 0 || !abort.signal.aborted)
      throw new DevError(`Dev service exited (${result.code})`);
  } finally {
    await runner.cleanup();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    if (abort.signal.aborted) process.exitCode = 130;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bootstrap().catch((error) => {
    // Avoid accidentally logging a parsed URL, command output or credentials in exception messages.
    console.error(
      error instanceof DevError
        ? error.message
        : "Dev startup failed. Check prerequisites and configuration; run node scripts/dev.mjs --help for options.",
    );
    process.exitCode ||= 1;
  });
}
