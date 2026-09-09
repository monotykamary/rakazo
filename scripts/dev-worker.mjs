#!/usr/bin/env node
// Local-only worker ownership. Code reload is explicit: restart drains before starting again.
// status/stop/restart are independent of API/web and never signal a recorded PID.
// The 0700 DATA_DIR/.dev-worker directory is an exclusive boot claim; its credential
// and descriptor are 0600. Config is HMACed in memory, never persisted as raw env.
// An orphaned claim fails closed: do not remove it without independently verifying
// that its entire worker host has ended. A dead manager does not prove a dead worker.
// API/web/full dev restarts keep the old worker source running until an explicit
// drained restart loads new code. Managed deployment/watch commands do not use this module.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class WorkerConfigurationError extends Error {
  constructor() {
    super(
      "The running worker uses a different launch configuration. Run node scripts/dev-worker.mjs stop, wait until node scripts/dev-worker.mjs status reports stopped, then run bun run dev from the same terminal. Active tasks are drained, not killed.",
    );
    this.name = "WorkerConfigurationError";
  }
}

const here = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = () =>
  new Error(
    "Worker ownership or configuration could not be verified; nothing was stopped. Inspect the private worker state before retrying.",
  );

async function privatePath(filename, directory = false) {
  const st = await lstat(filename);
  if (
    st.isSymbolicLink() ||
    (directory ? !st.isDirectory() : !st.isFile()) ||
    st.uid !== process.getuid() ||
    st.mode & 0o077
  )
    throw fail();
}
async function readPrivate(filename) {
  await privatePath(filename);
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.nlink !== 1)
      throw fail();
    return await fd.readFile("utf8");
  } finally {
    await fd.close();
  }
}
async function writePrivate(filename, value) {
  const temporary = `${filename}.pending`;
  const fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(value);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temporary, filename);
}
export async function workerLocation({ root, env }) {
  if (process.platform === "win32")
    throw new Error("Stable local worker requires POSIX process isolation");
  root = await realpath(root);
  const requested = path.resolve(root, env.DATA_DIR || "data");
  // Refuse symlinks at every component, including parents of DATA_DIR.
  let cursor = path.parse(requested).root;
  for (const part of requested.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const st = await lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink()) throw fail();
  }
  const dataStat = await lstat(requested);
  if (dataStat.uid !== process.getuid() || dataStat.mode & 0o022) throw fail();
  const data = await realpath(requested);
  const directory = path.join(data, ".dev-worker");
  return { root, data, directory };
}
async function fingerprint(env, token, command) {
  // Hash all inherited configuration except launcher/terminal bookkeeping. No raw config on disk.
  const entries = Object.entries(env)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(?:_|SHLVL|PWD|OLDPWD|TERM.*|COLORTERM|npm_.*|INIT_CWD|TURBO_.*)$/.test(key),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const roots = await Promise.all(
    [
      env.HOME,
      env.PI_CODING_AGENT_DIR || (env.HOME && path.join(env.HOME, ".pi/agent")),
      env.RAKAZO_PI_CWD,
      env.RAKAZO_PI_COMMAND,
    ]
      .filter((value) => value && path.isAbsolute(value))
      .map(async (value) => {
        try {
          return await realpath(value);
        } catch (error) {
          if (error.code === "ENOENT") return value;
          throw error;
        }
      }),
  );
  return createHmac("sha256", token)
    .update(JSON.stringify([entries, command, roots]))
    .digest("hex");
}
const defaultCommand = (root) => [
  process.execPath,
  "--import",
  "tsx",
  path.join(root, "apps/worker/src/index.ts"),
];
async function descriptor(location) {
  await privatePath(location.directory, true);
  const token = await readPrivate(path.join(location.directory, "credential"));
  const record = JSON.parse(await readPrivate(path.join(location.directory, "descriptor.json")));
  if (
    record.root !== location.root ||
    record.data !== location.data ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !/^[a-f0-9]{64}$/.test(record.instance)
  )
    throw fail();
  return { token, record };
}
export async function workerRequest(location, action, expectedConfig) {
  const { token, record } = await descriptor(location);
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(3000),
    headers: {
      authorization: createHmac("sha256", token)
        .update(JSON.stringify([challenge, record.instance, action, expectedConfig || ""]))
        .digest("hex"),
      "x-worker-instance": record.instance,
      "x-worker-challenge": challenge,
      ...(expectedConfig ? { "x-worker-config": expectedConfig } : {}),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403 && expectedConfig && action === "status") {
      // Verify ownership independently before diagnosing drift, including older managers.
      await workerRequest(location, "status");
      throw new WorkerConfigurationError();
    }
    throw fail();
  }
  const result = await response.json();
  const proof = createHmac("sha256", token)
    .update(JSON.stringify([challenge, record.instance, result.state, result.workerPid]))
    .digest("hex");
  if (result.proof !== proof) throw fail();
  return { state: result.state, workerPid: result.workerPid };
}
export async function workerControl(options, action = "status") {
  if (!["status", "stop"].includes(action)) throw new Error("Unknown worker action");
  const location = await workerLocation(options);
  try {
    await lstat(location.directory);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "stopped", workerPid: null };
    throw error;
  }
  return workerRequest(location, action);
}
export async function ensureWorker({ root, env, command }) {
  const location = await workerLocation({ root, env });
  command ??= defaultCommand(location.root);
  let owner = false;
  try {
    await mkdir(location.directory, { mode: 0o700 });
    owner = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (owner) {
    const token = randomBytes(32).toString("hex");
    await writePrivate(path.join(location.directory, "credential"), token);
    const config = await fingerprint(env, token, command);
    const child = spawn(process.execPath, [here, "--manager"], {
      cwd: location.root,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("error", () => {});
    child.send({ location, command, config, token }, () => {});
    child.disconnect();
    child.unref();
  }
  for (let i = 0; i < 150; i++) {
    try {
      const { token } = await descriptor(location);
      const result = await workerRequest(
        location,
        "status",
        await fingerprint(env, token, command),
      );
      if (result.state === "ready") return result;
      if (result.state !== "starting") throw fail();
    } catch (error) {
      // Only an unpublished descriptor is a retryable concurrent boot.
      if (error.code !== "ENOENT") throw error;
    }
    await sleep(100);
  }
  throw new Error("Worker startup timed out; use worker status/stop. No process was killed.");
}
async function manager({ location, command, config, token }) {
  let state = "starting";
  let worker;
  const instance = randomBytes(32).toString("hex");
  const stop = () => {
    if (state === "draining" || state === "stopped") return;
    state = "draining";
    if (worker?.connected) worker.send({ type: "dev-worker:drain" }, () => {});
    else if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null)
      state = "stopped";
  };
  const server = http.createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(
      createHmac("sha256", token)
        .update(
          JSON.stringify([
            req.headers["x-worker-challenge"],
            instance,
            req.url.slice(1),
            req.headers["x-worker-config"] || "",
          ]),
        )
        .digest("hex"),
    );
    if (
      req.method !== "POST" ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected) ||
      req.headers["x-worker-instance"] !== instance ||
      (req.headers["x-worker-config"] && req.headers["x-worker-config"] !== config)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (!["/status", "/stop"].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/stop") stop();
    const workerPid = worker?.pid ?? null;
    const proof = createHmac("sha256", token)
      .update(JSON.stringify([req.headers["x-worker-challenge"], instance, state, workerPid]))
      .digest("hex");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ state, workerPid, proof }));
    if (state === "stopped") res.once("finish", () => void finish());
  });
  let finishing;
  function finish() {
    finishing ??= (async () => {
      server.close();
      await rm(location.directory, { recursive: true });
    })();
    return finishing;
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await writePrivate(
    path.join(location.directory, "descriptor.json"),
    JSON.stringify({
      root: location.root,
      data: location.data,
      port: server.address().port,
      instance,
    }),
  );
  const output = await open(path.join(location.directory, "worker.log"), "wx", 0o600);
  try {
    worker = spawn(command[0], command.slice(1), {
      cwd: location.root,
      env: { ...process.env, RAKAZO_DEV_WORKER_IPC: "1" },
      stdio: ["ignore", output.fd, output.fd, "ipc"],
    });
    worker.on("message", (message) => {
      if (message?.type === "dev-worker:drain-failed") state = "failed";
      if (message?.type !== "dev-worker:ready") return;
      if (state === "starting") state = "ready";
      else if (state === "draining") worker.send({ type: "dev-worker:drain" }, () => {});
    });
    worker.on("error", () => {
      state = "failed";
    });
    worker.on("exit", () => {
      if (state === "draining") {
        state = "stopped";
        void finish();
      } else state = "failed";
    });
  } finally {
    await output.close();
  }
}
export async function restartWorker(options) {
  const location = await workerLocation(options);
  const { record } = await descriptor(location);
  await workerRequest(location, "stop");
  for (;;) {
    try {
      const current = await descriptor(location);
      if (current.record.instance !== record.instance) break;
      if ((await workerRequest(location, "status")).state === "failed") throw fail();
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          await lstat(location.directory);
        } catch (missing) {
          if (missing.code === "ENOENT") break;
          throw missing;
        }
        await sleep(100);
        continue;
      }
      // The authenticated manager closes its listener just before removing its state.
      if (error.cause?.code !== "ECONNREFUSED") throw error;
    }
    await sleep(200);
  }
  return ensureWorker(options);
}
export async function workerCli(
  action,
  { root = path.resolve(path.dirname(here), ".."), inherited = process.env } = {},
) {
  if (action === "--help") {
    console.log(
      "node scripts/dev-worker.mjs status|stop|restart\nstop requests drain and returns; status reports draining until completion.\nrestart waits for active tasks, then reloads source. No forced timeout.\nUse the same environment as bun dev. Configuration drift fails closed; an explicit restart permits a drained handoff.\nAn unreachable/foreign descriptor is never reclaimed automatically, because its worker may still be alive.",
    );
    return;
  }
  if (!["status", "stop", "restart"].includes(action))
    throw new Error("Use status, stop, or restart (drains active work; no forced timeout)");
  const {
    loadEnvironment,
    runtimeEnvironment,
    resolvePi,
    processes,
    validateSecrets,
    trustedEnvironment,
  } = await import("./dev.mjs");
  root = await realpath(root);
  const { stored, values: env } = await loadEnvironment(root, inherited);
  if (action !== "restart") {
    console.log(JSON.stringify(await workerControl({ root, env }, action)));
    return;
  }
  if (
    !trustedEnvironment(env) ||
    env.NODE_ENV === "production" ||
    env.RAKAZO_DEPLOY_DIR ||
    env.RAKAZO_COMPOSE_FILE
  )
    throw fail();
  validateSecrets(env);
  const runtime = runtimeEnvironment(root, env, env.RAKAZO_PI_COMMAND || "pi");
  if (inherited.DATABASE_URL && inherited.DATABASE_URL !== stored.DATABASE_URL)
    runtime.RAKAZO_DEV_DATABASE = "0";
  const runner = processes(root, runtime);
  try {
    runtime.RAKAZO_PI_COMMAND = await resolvePi(root, runtime, new Set(), runner);
  } finally {
    await runner.cleanup();
  }
  console.log(JSON.stringify(await restartWorker({ root, env: runtime })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--manager")
    process.once("message", (message) => void manager(message).catch(() => process.exit(1)));
  else
    workerCli(process.argv[2]).catch(() => {
      console.error(
        "Worker command failed. Use status to inspect lifecycle state; no forced kill was attempted.",
      );
      process.exitCode = 1;
    });
}
