import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callerEnvironment, executable, loadEnvironment } from "../../../scripts/dev.mjs";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function injected(root: string) {
  const entries = [path.join(root, "node_modules", ".bin")];
  for (let directory = root; ; directory = path.dirname(directory)) {
    entries.push(path.join(directory, "node_modules", ".bin"));
    if (path.dirname(directory) === directory) return entries;
  }
}
function bunEnvironment(root: string, caller: string) {
  return {
    npm_config_user_agent: "bun/1.4.2",
    npm_config_local_prefix: root,
    PATH: [...injected(root), caller].join(path.delimiter),
  };
}

describe("dev caller PATH", () => {
  const root = path.resolve("/synthetic/checkout");
  it("removes only the full Bun prefix, preserving caller order, duplicates and empty entries", () => {
    const caller = [
      "",
      path.join(root, "node_modules", ".bin"),
      "/synthetic/bin",
      "/synthetic/bin",
      "",
    ].join(path.delimiter);
    const original = bunEnvironment(root, caller);
    expect(callerEnvironment(root, original).PATH).toBe(caller);
    expect(original.PATH).not.toBe(caller);
    expect(callerEnvironment(root, callerEnvironment(root, original)).PATH).toBe(caller);
  });
  it("restores the pre-Portless path before executable resolution and version checks", () => {
    const original = {
      ...bunEnvironment(root, "/caller/bin"),
      RAKAZO_DEV_PORTLESS_CHILD: "1",
      RAKAZO_DEV_PI_PATH: "/caller/bin",
      PATH: "/portless/package/bin:/portless/node/bin:/caller/bin",
    };
    expect(callerEnvironment(root, original).PATH).toBe("/caller/bin");
    expect(original.PATH).toBe("/portless/package/bin:/portless/node/bin:/caller/bin");
  });
  it("does not alter direct Node or other package-manager environments", () => {
    for (const agent of [undefined, "npm/11", "pnpm/10"])
      expect(
        callerEnvironment(root, { ...bunEnvironment(root, "/bin"), npm_config_user_agent: agent })
          .PATH,
      ).toBe(bunEnvironment(root, "/bin").PATH);
  });
  it("leaves unknown prefixes and missing PATH untouched", () => {
    const env = {
      ...bunEnvironment(root, "/bin"),
      PATH: ["/custom", ...injected(root)].join(path.delimiter),
    };
    expect(callerEnvironment(root, env)).toEqual(env);
    expect(callerEnvironment(root, { npm_config_user_agent: "bun/1.4.2" })).not.toHaveProperty(
      "PATH",
    );
  });
  it("uses Bun's lexical package root even when the checkout was canonicalized", () => {
    const env = bunEnvironment(path.resolve("/synthetic/alias"), "/caller/bin");
    expect(callerEnvironment(root, env).PATH).toBe("/caller/bin");
  });
  it("matches the checkout when nested Bun retains outer package metadata", () => {
    const env = {
      ...bunEnvironment(root, "/caller/bin"),
      npm_config_local_prefix: path.resolve("/other/package"),
    };
    expect(callerEnvironment(root, env).PATH).toBe("/caller/bin");
  });
  it("preserves explicit Pi and profile selections through the shared environment loader", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "rakazo-path-test-"));
    temporary.push(fixture);
    await writeFile(
      path.join(fixture, ".env"),
      "RAKAZO_PI_COMMAND=./chosen-pi\nPI_CODING_AGENT_DIR=./profile\n",
    );
    const loaded = await loadEnvironment(fixture, bunEnvironment(fixture, "/caller/bin"));
    expect(loaded.values).toMatchObject({
      PATH: "/caller/bin",
      RAKAZO_PI_COMMAND: "./chosen-pi",
      PI_CODING_AGENT_DIR: "./profile",
    });
  });
  it.skipIf(process.platform === "win32").each([false, true])(
    "real bun startup bypasses stale ancestor shims while workspace tools remain available (Portless=%s)",
    async (portless) => {
      const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "rakazo-path-probe-")));
      temporary.push(base);
      const root = path.join(base, "checkout with spaces");
      const system = path.join(base, "system");
      const ancestor = path.join(base, "node_modules", ".bin");
      const local = path.join(root, "node_modules", ".bin");
      await Promise.all([root, system, ancestor, local].map((p) => mkdir(p, { recursive: true })));
      const script = async (dir: string, name: string, body: string) =>
        writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      await script(ancestor, "pi", "exit 91");
      await script(ancestor, "pi-real", "exit 92");
      await script(system, "pi", 'exec pi-real "$@"');
      await script(system, "pi-real", 'printf "0.85.1\\n"');
      await script(local, "workspace-probe", 'printf "workspace-ok\\n"');
      const source = new URL("../../../scripts/dev.mjs", import.meta.url).href;
      await writeFile(
        path.join(root, "entry.mjs"),
        `
      import { loadEnvironment, resolvePi, processes, validatePiVersion } from ${JSON.stringify(source)};
      const { values: env } = await loadEnvironment(process.cwd());
      const runner = processes(process.cwd(), env);
      try {
        const command = await resolvePi(process.cwd(), env, new Set(), runner);
        const version = await runner.run(command, ["--version"], { capture: true });
        validatePiVersion(version.output);
        console.log(version.output.trim());
        const workspace = await runner.run(process.env.TEST_BUN, ["run", "--silent", "tool:probe"], { capture: true });
        console.log(workspace.output.trim());
      } finally { await runner.cleanup(); }
    `,
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            dev: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "entry.mjs"))}`,
            "tool:probe": "workspace-probe",
          },
        }),
      );
      const bun = await executable("bun", process.env, process.cwd());
      expect(bun).toBeTruthy();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TEST_BUN: bun!,
        PATH: [system, process.env.PATH].join(path.delimiter),
      };
      delete env.RAKAZO_PI_COMMAND;
      delete env.RAKAZO_DEV_PORTLESS_CHILD;
      delete env.RAKAZO_DEV_PI_PATH;
      if (portless) {
        env.RAKAZO_DEV_PORTLESS_CHILD = "1";
        env.RAKAZO_DEV_PI_PATH = env.PATH;
        env.PATH = [local, ancestor, env.PATH].join(path.delimiter);
      }
      const result = execFileSync(bun!, ["run", "--silent", "dev"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.trim().split("\n")).toEqual(["0.85.1", "workspace-ok"]);
    },
  );
});
