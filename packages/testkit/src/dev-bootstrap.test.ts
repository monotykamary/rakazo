import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availablePort,
  bootstrap,
  commandPhase,
  consent,
  databasePlan,
  defaults,
  devStartupMessage,
  ensureDatabase,
  environmentAdditions,
  executable,
  interactivePiEnvironment,
  options,
  PI_RUNTIME_VERSION,
  piInstallPlan,
  preflightServices,
  processes,
  readEnvironment,
  resolvePi,
  runtimeEnvironment,
  saveEnvironment,
  serviceUrls,
  trustedEnvironment,
  validatePiVersion,
  validateSecrets,
  waitFor,
} from "../../../scripts/dev.mjs";

import { WorkerConfigurationError } from "../../../scripts/dev-worker.mjs";

it("reports authenticated worker configuration drift without exposing arbitrary exceptions", () => {
  expect(devStartupMessage(new WorkerConfigurationError())).toContain(
    "different launch configuration",
  );
  expect(devStartupMessage(new WorkerConfigurationError())).toContain(
    "scripts/dev-worker.mjs stop",
  );
  expect(
    devStartupMessage(new Error("postgresql://fake:private@example.invalid/db")),
  ).not.toContain("private");
});

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-dev-test-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// These tests read only synthetic .env files under fresh temporary directories.
describe("source dev consent and environment", () => {
  it("preserves Pi caller PATH without changing the service PATH", () => {
    const values = { PATH: "/caller/bin:/system/bin" };
    const env = runtimeEnvironment("/checkout", values, "/caller/bin/pi");
    expect(env.PATH).toBe(values.PATH);
    expect(env.RAKAZO_DEV_PI_PATH).toBe(values.PATH);
    expect(
      runtimeEnvironment("/checkout", { ...env, PATH: "/package/bin" }, "pi").RAKAZO_DEV_PI_PATH,
    ).toBe(values.PATH);
    expect(values).not.toHaveProperty("RAKAZO_DEV_PI_PATH");
  });
  it("respects absolute Pi cwd overrides and refuses relative ones", () => {
    expect(
      runtimeEnvironment("/checkout", { RAKAZO_PI_CWD: "/other/source" }, "pi").RAKAZO_PI_CWD,
    ).toBe("/other/source");
    expect(() => runtimeEnvironment("/checkout", { RAKAZO_PI_CWD: "./relative" }, "pi")).toThrow(
      "absolute",
    );
  });
  it("rejects blank and placeholder secrets without rotating existing keys", () => {
    const valid = defaults("/checkout", {}, true);
    expect(() => validateSecrets(valid)).not.toThrow();
    for (const key of [
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "SCREEN_PROXY_SECRET",
      "SANDBOX_SUPERVISOR_TOKEN",
    ]) {
      for (const value of ["", "  ", "replace-with-32-plus-character-secret"])
        expect(() => validateSecrets({ ...valid, [key]: value })).toThrow(key);
    }
    expect(defaults("/checkout", {}, false)).not.toHaveProperty("ENCRYPTION_KEY");
    expect(() =>
      validateSecrets({ ...valid, SCREEN_PROXY_SECRET: valid.BETTER_AUTH_SECRET }),
    ).toThrow("independent");
  });

  it("requires explicit noninteractive consent", async () => {
    const streams = { input: { isTTY: false }, output: { isTTY: false } };
    expect(await consent("Trust?", false, streams)).toBe(false);
    expect(await consent("Trust?", true, streams)).toBe(true);
    expect(trustedEnvironment({ AGENT_RUNTIME: "pi", RAKAZO_TRUST_LOCAL_PI: "1" })).toBe(false);
    expect(trustedEnvironment({ AGENT_RUNTIME: "pi-local", RAKAZO_TRUST_LOCAL_PI: "1" })).toBe(
      true,
    );
  });
  it("rejects unknown options before reading configuration", () => {
    expect(() => options(["--yes"])).toThrow("Unknown dev option");
    expect(options(["--trust-local-pi"]).has("--trust-local-pi")).toBe(true);
  });
  it("refuses production even with consent without changing a file", async () => {
    const root = await fixture();
    const text = "NODE_ENV=production\nAGENT_RUNTIME=pi\n";
    await writeFile(path.join(root, ".env"), text);
    await expect(bootstrap({ root, inherited: {}, args: ["--trust-local-pi"] })).rejects.toThrow(
      "managed deployment",
    );
    expect(await readFile(path.join(root, ".env"), "utf8")).toBe(text);
  });
  it("creates private independent random secrets and is idempotent", async () => {
    const root = await fixture();
    const snapshot = await readEnvironment(root);
    const additions = defaults(root, {}, snapshot.fresh);
    await saveEnvironment(root, snapshot, additions);
    const text = await readFile(path.join(root, ".env"), "utf8");
    const env = parseEnv(text);
    const secrets = [
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "SCREEN_PROXY_SECRET",
      "SANDBOX_SUPERVISOR_TOKEN",
    ].map((key) => env[key]);
    for (const secret of secrets) expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set([...secrets, new URL(env.DATABASE_URL).password]).size).toBe(5);
    expect((await stat(path.join(root, ".env"))).mode & 0o777).toBe(0o600);
    expect(env.SANDBOX_PROVIDER).toBe("desktop");
    await saveEnvironment(root, await readEnvironment(root), defaults(root, env, false));
    expect(await readFile(path.join(root, ".env"), "utf8")).toBe(text);
  });
  it("preserves comments, empty values, existing tokens, data and managed runtime", async () => {
    const root = await fixture();
    const text =
      "# keep this\nBETTER_AUTH_SECRET=fake-existing\nENCRYPTION_KEY=\nDATA_DIR=./old-data\nAGENT_RUNTIME=pi\nDATABASE_URL=postgres://fake:fake@db.invalid/app";
    await writeFile(path.join(root, ".env"), text);
    const stored = parseEnv(text);
    const additions = defaults(root, stored, false);
    expect(additions).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(additions).not.toHaveProperty("ENCRYPTION_KEY");
    expect(additions).not.toHaveProperty("DATABASE_URL");
    expect(additions).not.toHaveProperty("RAKAZO_DEV_DATABASE");
    await saveEnvironment(root, await readEnvironment(root), additions);
    expect((await readFile(path.join(root, ".env"), "utf8")).startsWith(`${text}\n`)).toBe(true);
    const runtime = runtimeEnvironment(root, stored, "/fake/bin/pi");
    expect(runtime).toMatchObject({
      AGENT_RUNTIME: "pi-local",
      SANDBOX_PROVIDER: "desktop",
      RAKAZO_TRUST_LOCAL_PI: "1",
      RAKAZO_PI_COMMAND: "/fake/bin/pi",
      RAKAZO_PI_CWD: root,
      DATA_DIR: path.join(root, "old-data"),
      DATABASE_URL: stored.DATABASE_URL,
    });
    expect(stored.AGENT_RUNTIME).toBe("pi");
  });
  it("never creates a database when a URL was supplied", () => {
    const env = { DATABASE_URL: "postgres://fake:fake@db.invalid/app" };
    expect(defaults("/checkout", env, true)).not.toHaveProperty("RAKAZO_DEV_DATABASE");
    expect(databasePlan("/checkout", env)).toBeNull();
  });
  it("refuses a symlink and concurrent env replacement", async () => {
    const root = await fixture();
    const target = path.join(root, "target");
    await writeFile(target, "UNTOUCHED=1");
    await symlink(target, path.join(root, ".env"));
    await expect(readEnvironment(root)).rejects.toThrow("regular file");
    await rm(path.join(root, ".env"));
    const snapshot = await readEnvironment(root);
    await writeFile(path.join(root, ".env"), "OTHER=1");
    await expect(saveEnvironment(root, snapshot, { ADD: "1" })).rejects.toThrow();
    const existing = await readEnvironment(root);
    await writeFile(path.join(root, ".env"), "OTHER=2");
    await expect(saveEnvironment(root, existing, { ADD: "1" })).rejects.toThrow("changed");
    expect(await readFile(target, "utf8")).toBe("UNTOUCHED=1");
    expect(await readFile(path.join(root, ".env"), "utf8")).toBe("OTHER=2");
  });
});

describe("live probe regressions", () => {
  it("selects a free port before saving and leaves supplied URLs untouched", async () => {
    const root = await fixture();
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const occupied = (listener.address() as { port: number }).port;
    try {
      const additions = await environmentAdditions(root, {}, true, occupied);
      const selected = Number(new URL(additions.DATABASE_URL).port);
      expect(selected).not.toBe(occupied);
      expect(await availablePort(selected)).toBe(selected);
      await saveEnvironment(root, await readEnvironment(root), additions);
      expect(parseEnv(await readFile(path.join(root, ".env"), "utf8")).DATABASE_URL).toBe(
        additions.DATABASE_URL,
      );
      expect(
        await environmentAdditions(
          root,
          { DATABASE_URL: "postgres://fake:fake@127.0.0.1:5433/app" },
          true,
          occupied,
        ),
      ).not.toHaveProperty("DATABASE_URL");
      expect(await environmentAdditions(root, {}, false, occupied)).not.toHaveProperty(
        "DATABASE_URL",
      );
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    const preferred = await availablePort(0);
    expect(new URL((await environmentAdditions(root, {}, true, preferred)).DATABASE_URL).port).toBe(
      String(preferred),
    );
  });

  it.each(["API", "Web"])(
    "rejects occupied %s listeners without stopping them",
    async (service) => {
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const occupied = (listener.address() as { port: number }).port;
      const free = await availablePort(0);
      try {
        await expect(
          preflightServices({
            API_PORT: String(service === "API" ? occupied : free),
            WEB_ORIGIN: `http://127.0.0.1:${service === "Web" ? occupied : free}`,
          }),
        ).rejects.toThrow(`${service} listener port`);
        expect(listener.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    },
  );

  it("lets interactive Pi handle repeated Ctrl+C and exit normally without changing the environment", async () => {
    const root = await fixture();
    const command = path.join(root, "fake-pi");
    const text = "# preserved\nDATABASE_URL=postgres://fake:fake@db.invalid/app\n";
    await writeFile(path.join(root, ".env"), text);
    await writeFile(
      command,
      `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('0.85.1'); } else { process.on('SIGTERM',()=>process.exit(9)); process.kill(process.ppid,'SIGINT'); setTimeout(()=>process.kill(process.ppid,'SIGINT'),30); setTimeout(()=>{console.log('pi-normal-exit');process.exit(0)},100); }\n`,
      { mode: 0o700 },
    );
    const module = new URL("../../../scripts/dev.mjs", import.meta.url).href;
    const inherited = {
      PATH: root,
      RAKAZO_PI_COMMAND: command,
      PI_CODING_AGENT_DIR: path.join(root, "profile"),
    };
    const runner = processes(root, {});
    try {
      const result = await runner.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { bootstrap } from ${JSON.stringify(module)}; await bootstrap(${JSON.stringify({ root, inherited, args: ["--pi"] })});`,
        ],
        { capture: true },
      );
      expect(result.code).toBe(0);
      expect(result.output).toContain("pi-normal-exit");
      expect(await readFile(path.join(root, ".env"), "utf8")).toBe(text);
      await expect(stat(inherited.PI_CODING_AGENT_DIR)).rejects.toThrow();
    } finally {
      await runner.cleanup();
    }
  });
  it("reports only allowlisted Mocker phase tokens", async () => {
    expect(commandPhase("mocker", ["volume", "create", "fake-secret"])).toBe(
      "mocker volume create",
    );
    expect(commandPhase("mocker", ["exec", "fake-secret", "password"])).toBe("mocker exec");
    expect(commandPhase("mocker", ["fake-secret"])).toBe("mocker");
    const root = await fixture();
    const command = path.join(root, "mocker");
    await writeFile(command, "#!/bin/sh\necho fake-secret >&2\nexit 1\n", { mode: 0o700 });
    const runner = processes(root, {});
    try {
      await expect(
        runner.run(command, ["volume", "create", "fake-secret"], { capture: true }),
      ).rejects.toThrow("mocker volume create failed (1)");
    } finally {
      await runner.cleanup();
    }
  });
});
describe("Mocker PostgreSQL plan", () => {
  async function plan() {
    const root = await fixture();
    return databasePlan(root, {
      DATA_DIR: path.join(root, "data"),
      DATABASE_URL: "postgres://rakazo:fake-password@127.0.0.1:5433/rakazo",
      RAKAZO_DEV_DATABASE: "1",
    });
  }
  function mocker(p, existing = false) {
    const state = { volume: existing, container: null as any, data: "", failCreate: false };
    const run = vi.fn(async (_command, args) => {
      if (args === p.inspect)
        return { code: state.container ? 0 : 1, output: JSON.stringify([state.container]) };
      if (args === p.volumeInspect)
        return {
          code: state.volume ? 0 : 1,
          output: JSON.stringify({ name: p.volume, labels: {} }),
        };
      if (args === p.volumeCreate) {
        if (state.failCreate) throw new Error("create failed");
        state.volume = true;
      }
      return { code: 0, output: "" };
    });
    return { run, state };
  }
  async function marker(p, state = "ready") {
    await mkdir(p.bindDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(p.bindDir, "owner"),
      JSON.stringify({ checkout: p.id, volume: p.volume, state }),
      { mode: 0o600 },
    );
  }
  it("uses native checkout volumes and nested PGDATA, never host binds or volume labels", async () => {
    const p = await plan();
    expect(p.volume).toBe(`${p.name}-data`);
    expect(p.run).toContain(`${p.volume}:/var/lib/postgresql/data`);
    expect(p.run.slice(p.run.indexOf("--env"), p.run.indexOf("--env") + 2)).toEqual([
      "--env",
      "PGDATA=/var/lib/postgresql/data/pgdata",
    ]);
    expect(p.run).toContain("127.0.0.1:5433:5432");
    expect(p.run).toContain(`dev.rakazo.config=${p.configId}`);
    expect(p.run.join(" ")).not.toContain("fake-password");
    expect(p.run).not.toContain("--rm");
    expect(p.volumeCreate).toEqual(["volume", "create", p.volume]);
  });
  it("creates and verifies an unlabeled volume with private ownership and credentials", async () => {
    const p = await plan();
    const runner = mocker(p);
    await ensureDatabase(p, runner);
    expect(runner.run.mock.calls.map((c) => c[1])).toEqual([
      p.inspect,
      p.volumeInspect,
      p.volumeCreate,
      p.volumeInspect,
      p.run,
      p.ready,
    ]);
    expect((await stat(p.bindDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(p.bindDir, "owner"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(p.bindDir, "owner"), "utf8"))).toEqual({
      checkout: p.id,
      volume: p.volume,
      state: "ready",
    });
    expect((await stat(p.envFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(p.envFile, "utf8")).toBe(p.credentials);
  });
  it.each([true, false])(
    "restarts persistent storage with owned container (running=%s)",
    async (running) => {
      const p = await plan();
      const runner = mocker(p);
      await ensureDatabase(p, runner);
      runner.state.data = "persisted";
      runner.state.container = {
        Config: { Labels: { "dev.rakazo.checkout": p.id, "dev.rakazo.config": p.configId } },
        state: { Status: running ? "running" : "stopped" },
      };
      runner.run.mockClear();
      await ensureDatabase(p, runner);
      expect(runner.run.mock.calls.map((c) => c[1])).toEqual(
        running
          ? [p.inspect, p.volumeInspect, p.ready]
          : [p.inspect, p.volumeInspect, p.start, p.ready],
      );
      expect(runner.state.data).toBe("persisted");
    },
  );
  it.each([false, true])("recovers pending creation with volume present=%s", async (exists) => {
    const p = await plan();
    await marker(p, "pending");
    const runner = mocker(p, exists);
    await ensureDatabase(p, runner);
    expect(runner.run.mock.calls.filter((c) => c[1] === p.volumeCreate)).toHaveLength(
      exists ? 0 : 1,
    );
    expect(JSON.parse(await readFile(path.join(p.bindDir, "owner"), "utf8")).state).toBe("ready");
  });
  it("retains pending ownership after failed creation and retries", async () => {
    const p = await plan();
    const runner = mocker(p);
    runner.state.failCreate = true;
    await expect(ensureDatabase(p, runner)).rejects.toThrow("create failed");
    expect(JSON.parse(await readFile(path.join(p.bindDir, "owner"), "utf8")).state).toBe("pending");
    runner.state.failCreate = false;
    await ensureDatabase(p, runner);
  });
  it("refuses missing previously ready volume instead of creating an empty database", async () => {
    const p = await plan();
    await marker(p);
    const runner = mocker(p);
    await expect(ensureDatabase(p, runner)).rejects.toThrow("volume is missing");
    expect(runner.run.mock.calls.map((c) => c[1])).toEqual([p.inspect, p.volumeInspect]);
  });
  it("never adopts an unknown preexisting volume or creates its marker", async () => {
    const p = await plan();
    const runner = mocker(p, true);
    await expect(ensureDatabase(p, runner)).rejects.toThrow("ownership mismatch");
    await expect(stat(p.bindDir)).rejects.toThrow();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
  it.each(["missing", "wrong", "symlink", "directory-symlink", "public", "wrong-volume"])(
    "refuses %s ownership",
    async (kind) => {
      const p = await plan();
      await marker(p);
      const owner = path.join(p.bindDir, "owner");
      if (kind === "missing") await rm(owner);
      if (kind === "wrong") await writeFile(owner, "other-checkout");
      if (kind === "wrong-volume")
        await writeFile(owner, JSON.stringify({ checkout: p.id, volume: "other", state: "ready" }));
      if (kind === "public") {
        await rm(owner);
        await writeFile(owner, "{}", { mode: 0o644 });
      }
      if (kind === "symlink") {
        await rm(owner);
        await symlink(p.envFile, owner);
      }
      if (kind === "directory-symlink") {
        await rm(p.bindDir, { recursive: true });
        await symlink(path.dirname(p.bindDir), p.bindDir);
      }
      const runner = mocker(p, true);
      await expect(ensureDatabase(p, runner)).rejects.toThrow("ownership mismatch");
      expect(runner.run.mock.calls.map((c) => c[1])).toEqual([p.inspect]);
    },
  );
  it("does not follow a postgres env-file symlink", async () => {
    const p = await plan();
    await marker(p);
    const target = path.join(p.bindDir, "untouched");
    await writeFile(target, "fake-existing-secret");
    await symlink(target, p.envFile);
    const runner = mocker(p, true);
    await expect(ensureDatabase(p, runner)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("fake-existing-secret");
    expect(runner.run.mock.calls.map((c) => c[1])).toEqual([p.inspect, p.volumeInspect]);
  });
  it.each(["ownership", "configuration"])(
    "rejects container %s before touching storage",
    async (kind) => {
      const p = await plan();
      const runner = mocker(p);
      runner.state.container = {
        Config: { Labels: kind === "ownership" ? {} : { "dev.rakazo.checkout": p.id } },
        State: { Status: "stopped" },
      };
      await expect(ensureDatabase(p, runner)).rejects.toThrow(`${kind} mismatch`);
      expect(runner.run).toHaveBeenCalledTimes(1);
      await expect(stat(p.bindDir)).rejects.toThrow();
    },
  );
  it("binds the container configuration label to volume, image, PGDATA and credentials identity", async () => {
    const p = await plan();
    const { createHash } = await import("node:crypto");
    expect(p.configId).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            p.volume,
            "/var/lib/postgresql/data/pgdata",
            "5433",
            "rakazo",
            "rakazo",
            "postgres:16",
          ]),
        )
        .digest("hex"),
    );
  });
  it("refuses creation that cannot be verified and keeps its pending checkpoint", async () => {
    const p = await plan();
    const runner = {
      run: vi.fn(async (_command, args) => ({
        code: args === p.inspect || args === p.volumeInspect ? 1 : 0,
        output: "",
      })),
    };
    await expect(ensureDatabase(p, runner)).rejects.toThrow("could not be verified");
    expect(JSON.parse(await readFile(path.join(p.bindDir, "owner"), "utf8")).state).toBe("pending");
    expect(runner.run.mock.calls.some((c) => c[1] === p.run)).toBe(false);
  });
  it("rejects remote or env-injected managed credentials", () => {
    for (const url of [
      "postgres://u:p@db.invalid:5433/db",
      "postgres://u:p%0AESCAPE=1@127.0.0.1:5433/db",
    ]) {
      expect(() =>
        databasePlan("/checkout", {
          RAKAZO_DEV_DATABASE: "1",
          DATABASE_URL: url,
          DATA_DIR: "/checkout/data",
        }),
      ).toThrow();
    }
  });
});

describe("process and install boundaries", () => {
  it("uses API_PORT for API health and the configured web origin", () => {
    expect(
      serviceUrls({ API_PORT: "3199", WEB_ORIGIN: "http://127.0.0.1:5199" }).map((url) => url.href),
    ).toEqual(["http://127.0.0.1:3199/health", "http://127.0.0.1:5199/"]);
  });
  it("handles spawn failures and waits for graceful child close during cleanup", async () => {
    const root = await fixture();
    const missing = processes(root, {});
    const failed = missing.launch(path.join(root, "missing"), [], { capture: true });
    await missing.cleanup();
    expect((await failed.done).code).toBe(1);
    const runner = processes(root, {});
    const child = runner.launch(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('closed');process.exit(0)},100));process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      { capture: true },
    );
    await new Promise((resolve) => child.child.stdout.once("data", resolve));
    await runner.cleanup();
    expect((await child.done).output).toBe("readyclosed");
    expect(child.child.exitCode).toBe(0);
  });

  it("checks installed Pi supports agent_settled without changing existing Pi", async () => {
    expect(validatePiVersion("0.85.1\n")).toBe(PI_RUNTIME_VERSION);
    expect(validatePiVersion("pi 0.86.0")).toBe("0.86.0");
    for (const version of ["0.84.9", "0.85.0", "unknown", "1.0.0"])
      expect(() => validatePiVersion(version)).toThrow("dev:kit");
    const pkg = JSON.parse(
      await readFile(new URL("../../pi-kit/package.json", import.meta.url), "utf8"),
    );
    expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(PI_RUNTIME_VERSION);
    const root = await fixture();
    const command = path.join(root, "pi");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const runner = { run: vi.fn() };
    expect(await resolvePi(root, { PATH: root }, new Set(), runner)).toBe(command);
    expect(runner.run).not.toHaveBeenCalled();
    await expect(
      resolvePi(
        root,
        { PATH: root, RAKAZO_PI_COMMAND: "missing" },
        new Set(["--install-pi"]),
        runner,
      ),
    ).rejects.toThrow("override");
    expect(runner.run).not.toHaveBeenCalled();
  });
  it("opens Pi with selected command but never copies application env secrets or model defaults", () => {
    const env = interactivePiEnvironment(
      {
        PATH: "/fake/bin",
        BETTER_AUTH_SECRET: "fake",
        ENCRYPTION_KEY: "fake",
        DATABASE_URL: "fake",
        SANDBOX_SUPERVISOR_TOKEN: "fake",
        RAKAZO_TRUST_LOCAL_PI: "1",
      },
      {
        RAKAZO_PI_COMMAND: "/fake/pi",
        ANTHROPIC_API_KEY: "not-copied",
        PI_DEFAULT_MODEL: "not-copied",
      },
    );
    expect(env).toEqual({ PATH: "/fake/bin", RAKAZO_PI_COMMAND: "/fake/pi" });
    expect(
      interactivePiEnvironment(
        { PI_CODING_AGENT_DIR: "/explicit/profile" },
        { RAKAZO_PI_CWD: "/explicit/source", PI_CODING_AGENT_DIR: "/ignored/profile" },
      ),
    ).toMatchObject({
      PI_CODING_AGENT_DIR: "/explicit/profile",
      RAKAZO_PI_CWD: "/explicit/source",
    });
  });

  it("retries readiness deterministically and fails on exhaustion or cancellation", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const delay = vi.fn(async () => {});
    await waitFor(probe, { delay, attempts: 3 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    await expect(waitFor(async () => false, { delay, attempts: 2 })).rejects.toThrow("timed out");
    await expect(waitFor(async () => true, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("finds a single executable including paths with spaces, not shell arguments", async () => {
    const root = await fixture();
    const command = path.join(root, "custom pi");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect(await executable("custom pi", { PATH: root }, root)).toBe(command);
    expect(await executable("./custom pi", { PATH: "" }, root)).toBe(command);
    expect(await executable("pi --unsafe", { PATH: root }, root)).toBeNull();
  });
  it("pins Pi and never installs globally or executes lifecycle scripts", () => {
    const plan = piInstallPlan("/checkout", "0.85.1");
    expect(plan.args).toContain("@earendil-works/pi-coding-agent@0.85.1");
    expect(plan.args).toContain("--ignore-scripts");
    expect(plan.args).not.toContain("-g");
    expect(plan.command).toBe("/checkout/data/dev/pi/node_modules/.bin/pi");
    expect(() => piInstallPlan("/checkout", "latest")).toThrow("exact reviewed version");
  });
  it("passes env without a shell, propagates failure, and cleans up only owned children", async () => {
    const root = await fixture();
    const runner = processes(root, { TEST_VALUE: "literal; $(not-a-command)" });
    try {
      const output = await runner.run(
        process.execPath,
        ["-e", "process.stdout.write(process.env.TEST_VALUE)"],
        { capture: true },
      );
      expect(output.output).toBe("literal; $(not-a-command)");
      await expect(
        runner.run(process.execPath, ["-e", "process.exit(7)"], { capture: true }),
      ).rejects.toThrow("failed (7)");
      const child = runner.launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        capture: true,
      });
      await runner.cleanup();
      expect((await child.done).code).not.toBe(0);
      expect(() => runner.launch(process.execPath, [])).toThrow("cancelled");
    } finally {
      await runner.cleanup();
    }
  });
  it("registers only source services by default and preserves managed watchers", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.scripts.dev).toBe("node scripts/dev.mjs");
    expect(pkg.scripts["dev:services"]).toContain("--env-mode=loose");
    for (const service of ["api", "web"])
      expect(pkg.scripts["dev:services"]).toContain(`--filter=@rakazo/${service}`);
    expect(pkg.scripts["dev:services"]).not.toMatch(/desktop|supervisor|worker/);
    for (const action of ["status", "stop", "restart"])
      expect(pkg.scripts[`dev:worker:${action}`]).toBe(`node scripts/dev-worker.mjs ${action}`);
    expect(pkg.scripts["dev:managed"]).toContain("--filter=@rakazo/sandbox-supervisor");
    expect(pkg.scripts["dev:kit"]).toContain("--setup-kit");
    const ignored = await readFile(new URL("../../../.dockerignore", import.meta.url), "utf8");
    expect(ignored.split("\n")).toContain("**/.dev-worker");
    expect(ignored.split("\n")).toContain("**/.pi");
  });
});
