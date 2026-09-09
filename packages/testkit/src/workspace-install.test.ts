import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const temporary: string[] = [];
const env = { ...process.env, BUN_INSTALL_CACHE_DIR: "", npm_config_user_agent: "" };

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "rakazo-bun-contract-"));
  temporary.push(directory);
  const write = (file: string, value: object | string) => {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", { name: "fixture", private: true, workspaces: ["packages/*"] });
  write("bunfig.toml", '[install]\nlinker = "isolated"\n[run]\nbun = false\n');
  for (const name of ["one", "two"]) {
    write(`packages/${name}/package.json`, {
      name: `@fixture/${name}`,
      version: "1.0.0",
      scripts: { test: "node probe.cjs" },
    });
    write(
      `packages/${name}/probe.cjs`,
      'console.log(JSON.stringify({runtime:process.versions.bun?"bun":"node",cwd:require("node:path").basename(process.cwd()),args:process.argv.slice(2)}))',
    );
  }
  return { directory, write };
}

describe("Bun workspace contract", () => {
  it("pins the package manager without replacing Vitest or Node", () => {
    expect(pkg.packageManager).toBe("bun@1.4.2");
    expect(pkg.engines).toEqual({ node: "^24.11.0 || >=26.0.0", bun: "1.4.2" });
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.preinstall).toBe("node scripts/check-package-manager.mjs");
    expect(pkg.pnpm).toBeUndefined();
    expect(pkg.workspaces).toEqual([
      "apps/*",
      "packages/*",
      "infra/sandboxes/supervisor",
      "infra/updater",
    ]);
    expect(pkg.overrides).toEqual({ react: "19.2.3", "react-dom": "19.2.3" });
    expect(pkg.patchedDependencies["app-builder-lib@26.15.3"]).toBe(
      "patches/app-builder-lib@26.15.3.patch",
    );
    expect(read("bunfig.toml")).toContain('linker = "isolated"');
    expect(read("bunfig.toml")).toContain("bun = false");
    expect(pkg.trustedDependencies).toContain("esbuild");
    expect(pkg.trustedDependencies).toContain("@prisma/engines");
    expect(pkg.trustedDependencies).not.toContain("pi-fabric");
    expect(existsSync(path.join(root, "bun.lock"))).toBe(true);
    expect(existsSync(path.join(root, "pnpm-lock.yaml"))).toBe(false);
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("rejects other package managers before installation", () => {
    const command = path.join(root, "scripts/check-package-manager.mjs");
    const accepted = spawnSync(process.execPath, [command], {
      env: { ...env, npm_config_user_agent: "bun/1.4.2 npm/? node/v24.0.0" },
    });
    expect(accepted.status, accepted.stderr?.toString()).toBe(0);
    const rejected = spawnSync(process.execPath, [command], {
      env: { ...env, npm_config_user_agent: "npm/10.0.0" },
    });
    expect(rejected.status).not.toBe(0);
  });

  it.each([
    ["24.10.0", false],
    ["24.11.0", true],
    ["25.9.0", false],
    ["26.0.0", true],
  ])("checks the upgraded toolchain's Node floor for %s", (version, accepted) => {
    const command = new URL("../../../scripts/check-package-manager.mjs", import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(command)});`,
      ],
      { env: { ...env, npm_config_user_agent: "bun/1.4.2 npm/?" } },
    );
    expect(probe.status === 0, probe.stderr?.toString()).toBe(accepted);
  });
  it("runs only the filtered script with Node and forwards its arguments", () => {
    const { directory } = fixture();
    const output = execFileSync("bun", ["run", "--filter", "@fixture/two", "test", "sentinel"], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    expect(output).toContain('"runtime":"node","cwd":"two","args":["sentinel"]');
    expect(output).not.toContain('"cwd":"one"');
    const binary = execFileSync(
      "bun",
      ["run", "--cwd", "packages/two", "node", "probe.cjs", "binary"],
      { cwd: directory, env, encoding: "utf8" },
    );
    expect(binary).toContain('"runtime":"node","cwd":"two","args":["binary"]');
  });

  it("does not duplicate a workspace cwd when spawning Prisma from its package", () => {
    for (const file of ["canary.ts", "harness.ts"]) {
      const source = read(`packages/testkit/src/cli/${file}`);
      expect(source).toContain('execSync("bun run prisma migrate deploy", {');
      expect(source).toContain('cwd: path.resolve("packages/db")');
    }
  });

  it("installs a local-only workspace and fails frozen install on manifest drift", () => {
    const { directory, write } = fixture();
    const args = [
      "install",
      "--offline",
      "--ignore-scripts",
      "--cache-dir",
      path.join(directory, "cache"),
    ];
    execFileSync("bun", args, { cwd: directory, env, stdio: "pipe" });
    const lock = readFileSync(path.join(directory, "bun.lock"), "utf8");
    execFileSync("bun", [...args, "--frozen-lockfile"], { cwd: directory, env, stdio: "pipe" });
    expect(readFileSync(path.join(directory, "bun.lock"), "utf8")).toBe(lock);
    write("leaf/package.json", { name: "fixture-leaf", version: "1.0.0" });
    write("packages/two/package.json", {
      name: "@fixture/two",
      version: "1.0.0",
      dependencies: { "fixture-leaf": "file:../../leaf" },
    });
    const result = spawnSync("bun", [...args, "--frozen-lockfile"], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("frozen");
    expect(readFileSync(path.join(directory, "bun.lock"), "utf8")).toBe(lock);
  });

  it.each([
    "infra/compose/Dockerfile",
    "infra/compose/Dockerfile.topology",
    "infra/updater/Dockerfile",
    "infra/sandboxes/supervisor/Dockerfile",
  ])("keeps Node and frozen Bun installs in %s", (file) => {
    const dockerfile = read(file);
    expect(dockerfile).toMatch(/FROM oven\/bun:1\.4\.2-slim@sha256:[a-f0-9]{64} AS bun/);
    expect(dockerfile).toMatch(/FROM node:24-bookworm/);
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).not.toContain("--omit optional");
    expect(dockerfile).not.toContain("corepack");
    if (file.includes("updater") || file.includes("supervisor")) {
      expect(dockerfile).toContain("COPY bunfig.toml bun.lock package.json ./");
      for (const entry of ["apps", "packages", "infra", "scripts", "patches", "vendor/pi-kit"])
        expect(dockerfile).toContain(`COPY ${entry} ${entry}`);
      expect(dockerfile).toContain("--production --filter");
    }
  });
});
