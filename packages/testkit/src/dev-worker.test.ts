import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  ensureWorker,
  restartWorker,
  workerCli,
  workerControl,
  workerLocation,
  workerRequest,
} from "../../../scripts/dev-worker.mjs";

const moduleUrl = pathToFileURL(path.resolve("scripts/dev-worker.mjs")).href;
const roots: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(fail = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "worker-probe-")));
  roots.push(root);
  const env = {
    PATH: process.env.PATH!,
    DATA_DIR: path.join(root, "data"),
    BETTER_AUTH_SECRET: "fake-auth-root",
  };
  const script = path.join(root, "fake.mjs");
  await writeFile(
    script,
    fail
      ? "process.exit(1)"
      : `
    import http from 'node:http';
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    let active = true;
    let callbacks = 0;
    const task = spawn(process.execPath, ['-e', "setInterval(()=>process.send('bridge-call'),25); process.on('message',m=>{if(m==='settle')process.exit(0)});"], {stdio:['ignore','ignore','ignore','ipc']});
    task.on('message', () => { callbacks++; });
    const bridge = http.createServer((req,res) => {
      if (req.url === '/settle') { active = false; task.send('settle'); }
      res.end(JSON.stringify({pid:process.pid, active, taskPid:task.pid, callbacks, callback:'works'}));
    });
    bridge.listen(0, '127.0.0.1', () => {
      writeFileSync('bridge.json', JSON.stringify({port:bridge.address().port}));
      console.log('worker-fixture-ready');
      process.send({type:'dev-worker:ready'});
    });
    process.on('message', m => {
      if(m.type === 'dev-worker:drain') {
        const wait = setInterval(() => { if(!active) { clearInterval(wait); bridge.close(() => process.exit(0)); } }, 25);
      }
    });
  `,
  );
  return { root, env, command: [process.execPath, script] };
}
async function bridge(root: string, route = "/") {
  const { port } = JSON.parse(await readFile(path.join(root, "bridge.json"), "utf8"));
  return (await fetch(`http://127.0.0.1:${port}${route}`)).json();
}
async function gone(options: Awaited<ReturnType<typeof fixture>>) {
  const { directory } = await workerLocation(options);
  for (let i = 0; i < 100; i++) {
    try {
      await lstat(directory);
    } catch {
      return;
    }
    await sleep(30);
  }
  throw new Error("worker did not stop");
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await bridge(root, "/settle").catch(() => {});
    await workerControl({ root, env: { DATA_DIR: path.join(root, "data") } }, "stop").catch(
      () => {},
    );
    await sleep(100);
    await rm(root, { recursive: true, force: true });
  }
});
async function launch(options: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {ensureWorker} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await ensureWorker(${JSON.stringify(options)})));`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  expect(code).toBe(0);
  return JSON.parse(output);
}
it("launcher exit/restart preserves worker PID, active task and live callback bridge; stop drains", async () => {
  const options = await fixture();
  const first = await launch(options);
  const second = await launch(options);
  expect(second.workerPid).toBe(first.workerPid);
  const task = await bridge(options.root);
  expect(task).toMatchObject({ pid: first.workerPid, active: true, callback: "works" });
  process.kill(task.taskPid, 0);
  await sleep(150);
  expect((await bridge(options.root)).callbacks).toBeGreaterThan(task.callbacks);
  expect((await workerControl(options, "stop")).state).toBe("draining");
  await sleep(150);
  expect((await workerControl(options)).state).toBe("draining");
  expect((await bridge(options.root)).active).toBe(true);
  await bridge(options.root, "/settle");
  await gone(options);
  expect(await workerControl(options)).toEqual({ state: "stopped", workerPid: null });
  expect(await workerControl(options, "stop")).toEqual({ state: "stopped", workerPid: null });
  expect((await launch(options)).workerPid).not.toBe(first.workerPid);
}, 15000);
it("duplicate concurrent boots converge; private manifests contain no raw application secrets", async () => {
  const options = await fixture();
  const results = await Promise.all([launch(options), launch(options), launch(options)]);
  expect(new Set(results.map((result) => result.workerPid)).size).toBe(1);
  const { directory } = await workerLocation(options);
  expect(await readFile(path.join(directory, "worker.log"), "utf8")).toContain(
    "worker-fixture-ready",
  );
  for (const name of ["credential", "descriptor.json", "worker.log"]) {
    expect((await lstat(path.join(directory, name))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(directory, name), "utf8")).not.toContain(
      options.env.BETTER_AUTH_SECRET,
    );
  }
});
it("changed auth/config fails closed without disturbing the task", async () => {
  const options = await fixture();
  await ensureWorker(options);
  await expect(
    ensureWorker({
      ...options,
      env: { ...options.env, BETTER_AUTH_SECRET: "different-fake-root" },
    }),
  ).rejects.toThrow();
  expect((await bridge(options.root)).active).toBe(true);
});
it("rejects unauthenticated requests, foreign checkout and reused PID/instance descriptors", async () => {
  const options = await fixture();
  await ensureWorker(options);
  const location = await workerLocation(options);
  const file = path.join(location.directory, "descriptor.json");
  const original = await readFile(file, "utf8");
  const record = JSON.parse(original);
  expect((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: "POST" })).status).toBe(
    403,
  );
  for (const patch of [{ root: "/foreign" }, { instance: "a".repeat(64) }]) {
    await writeFile(file, JSON.stringify({ ...record, ...patch }));
    await expect(workerRequest(location, "stop")).rejects.toThrow();
  }
  await writeFile(file, original);
  expect((await bridge(options.root)).active).toBe(true);
});
it("rejects symlink descriptors, credentials and unsafe permissions", async () => {
  const options = await fixture();
  await ensureWorker(options);
  const location = await workerLocation(options);
  for (const name of ["descriptor.json", "credential"]) {
    const file = path.join(location.directory, name);
    const original = await readFile(file, "utf8");
    const foreign = path.join(options.root, `foreign-${name}`);
    await writeFile(foreign, original, { mode: 0o600 });
    await rm(file);
    await symlink(foreign, file);
    await expect(workerRequest(location, "stop")).rejects.toThrow();
    await rm(file);
    await writeFile(file, original, { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(workerRequest(location, "stop")).rejects.toThrow();
    await chmod(file, 0o600);
  }
});
it("rejects symlink DATA_DIR and manager directory", async () => {
  const options = await fixture();
  await symlink(options.root, options.env.DATA_DIR);
  await expect(ensureWorker(options)).rejects.toThrow();
  await rm(options.env.DATA_DIR);
  const location = await workerLocation(options);
  await symlink(options.root, location.directory);
  await expect(ensureWorker(options)).rejects.toThrow();
});
it("launcher process-group termination leaves the whole worker host alive", async () => {
  const options = await fixture();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {ensureWorker} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await ensureWorker(${JSON.stringify(options)}))); setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const first = await new Promise<{ workerPid: number }>((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolve(JSON.parse(output));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid!, "SIGTERM");
  await exited;
  expect((await launch(options)).workerPid).toBe(first.workerPid);
  expect((await bridge(options.root)).callback).toBe("works");
});
it("explicit restart waits for work to settle before loading changed code", async () => {
  const options = await fixture();
  const first = await ensureWorker(options);
  const script = options.command[1];
  await writeFile(
    script,
    (await readFile(script, "utf8")).replace("callback:'works'", "callback:'updated'"),
  );
  expect((await ensureWorker(options)).workerPid).toBe(first.workerPid);
  let reloaded = false;
  const restart = restartWorker(options).then((result) => {
    reloaded = true;
    return result;
  });
  await sleep(250);
  expect(reloaded).toBe(false);
  expect((await bridge(options.root)).callback).toBe("works");
  await bridge(options.root, "/settle");
  expect((await restart).workerPid).not.toBe(first.workerPid);
  expect((await bridge(options.root)).callback).toBe("updated");
});
it("canonical Pi auth-root changes fail closed even if the configured symlink is unchanged", async () => {
  const options = await fixture();
  for (const name of ["profile-a", "profile-b"]) await mkdir(path.join(options.root, name));
  const profile = path.join(options.root, "profile");
  await symlink(path.join(options.root, "profile-a"), profile);
  const configured = { ...options, env: { ...options.env, PI_CODING_AGENT_DIR: profile } };
  await ensureWorker(configured);
  await rm(profile);
  await symlink(path.join(options.root, "profile-b"), profile);
  await expect(ensureWorker(configured)).rejects.toThrow();
  expect((await bridge(options.root)).active).toBe(true);
});
it("a reused localhost port cannot authenticate itself or obtain the credential", async () => {
  const options = await fixture();
  await ensureWorker(options);
  const location = await workerLocation(options);
  const file = path.join(location.directory, "descriptor.json");
  const original = await readFile(file, "utf8");
  const token = await readFile(path.join(location.directory, "credential"), "utf8");
  let received = "";
  const foreign = http.createServer((req, res) => {
    received = JSON.stringify(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ state: "ready", workerPid: process.pid, proof: "forged" }));
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(
      file,
      JSON.stringify({
        ...JSON.parse(original),
        port: (foreign.address() as { port: number }).port,
      }),
    );
    await expect(workerRequest(location, "stop")).rejects.toThrow();
    expect(received).not.toContain(token);
    expect(received).not.toContain(options.env.BETTER_AUTH_SECRET);
  } finally {
    await writeFile(file, original);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
  expect((await bridge(options.root)).active).toBe(true);
});
it("status/stop share bootstrap env precedence using only synthetic env files", async () => {
  const options = await fixture();
  await ensureWorker(options);
  const file = path.join(options.root, ".env");
  const text = 'DATA_DIR="unused-placeholder"\nBETTER_AUTH_SECRET="fake-stored-secret"\n';
  await writeFile(file, text, { mode: 0o600 });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const args = { root: options.root, inherited: { DATA_DIR: options.env.DATA_DIR } };
    await workerCli("status", args);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ state: "ready" });
    await workerCli("stop", args);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ state: "draining" });
    expect(JSON.stringify(output.mock.calls)).not.toContain("fake-stored-secret");
    expect(await readFile(file, "utf8")).toBe(text);
  } finally {
    output.mockRestore();
  }
});
it("status refuses a symlink env file without contacting or stopping the worker", async () => {
  const options = await fixture();
  await ensureWorker(options);
  const foreign = path.join(options.root, "foreign-env");
  await writeFile(foreign, "DATA_DIR=unused-placeholder");
  await symlink(foreign, path.join(options.root, ".env"));
  await expect(workerCli("status", { root: options.root, inherited: options.env })).rejects.toThrow(
    "regular file",
  );
  expect((await bridge(options.root)).active).toBe(true);
});
it("missing worker executable leaves an inspectable, stoppable failure", async () => {
  const options = await fixture();
  await expect(
    ensureWorker({ ...options, command: [path.join(options.root, "missing")] }),
  ).rejects.toThrow();
  expect((await workerControl(options)).state).toBe("failed");
  await workerControl(options, "stop");
  await gone(options);
});
it("startup failure is reported and explicitly stoppable without signaling an unrelated PID", async () => {
  const options = await fixture(true);
  await expect(ensureWorker(options)).rejects.toThrow();
  expect((await workerControl(options)).state).toBe("failed");
  await workerControl(options, "stop");
  await gone(options);
});
