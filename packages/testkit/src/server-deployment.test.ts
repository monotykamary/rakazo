import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const script = resolve("infra/compose/deploy-server.sh");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "rakazo-server-test-"));
  temporary.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    '#!/usr/bin/env bash\nif [[ "$*" == *"config --environment"* ]]; then\ncat <<EOF\nPOSTGRES_PASSWORD=test-db\nBETTER_AUTH_SECRET=test-auth\nENCRYPTION_KEY=test-encryption\nSCREEN_PROXY_SECRET=test-screen\nSANDBOX_SUPERVISOR_TOKEN=test-supervisor\nEOF\nfi\nprintf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"\n',
    { mode: 0o700 },
  );
  const destination = join(dir, "server");
  const log = join(dir, "docker.log");
  const run = (args: string[]) =>
    spawnSync("bash", [script, ...args, "--directory", destination], {
      env: { PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_LOG: log },
      encoding: "utf8",
      timeout: 20_000,
    });
  return { destination, log, run };
}

describe("always-on server deployment", () => {
  it("prepares private independent secrets, HTTPS and allowlisted signup without launching or requiring vendors", async () => {
    const f = await fixture();
    const args = [
      "--host",
      "app.example.com",
      "--allow-signup",
      "owner@example.com",
      "--prepare-only",
    ];
    const result = f.run(args);
    expect(result.status, result.stderr).toBe(0);
    const env = await readFile(join(f.destination, ".env"), "utf8");
    expect(env).toContain("BETTER_AUTH_URL=https://app.example.com");
    expect(env).toContain("WEB_ORIGIN=https://app.example.com");
    expect(env).toContain("API_URL=https://app.example.com");
    expect(env).toContain("SIGNUP_ALLOWLIST=owner@example.com");
    expect(env).toContain("SANDBOX_PROVIDER=docker");
    const keys = [
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "SCREEN_PROXY_SECRET",
      "SANDBOX_SUPERVISOR_TOKEN",
    ];
    const values = keys.map(
      (key) =>
        env
          .split("\n")
          .find((line) => line.startsWith(`${key}=`))!
          .split("=")[1]!,
    );
    expect(new Set(values).size).toBe(keys.length);
    for (const value of values) {
      expect(value).toMatch(/^[a-f0-9]{32,64}$/);
      expect(result.stdout).not.toContain(value);
    }
    expect((await stat(join(f.destination, ".env"))).mode & 0o777).toBe(0o600);
    const log = await readFile(f.log, "utf8");
    expect(log).not.toContain("up -d");
    expect(log).not.toContain("pull");
    expect(f.run(args).status).toBe(0);
    expect(await readFile(join(f.destination, ".env"), "utf8")).toBe(env);
    expect(
      f.run([
        "--host",
        "other.example.com",
        "--allow-signup",
        "owner@example.com",
        "--prepare-only",
      ]).status,
    ).not.toBe(0);
    expect(await readFile(join(f.destination, ".env"), "utf8")).toBe(env);
  });

  it("rejects URLs, environment injection and missing owner before creating state", async () => {
    for (const host of [
      "https://app.example.com",
      "127.0.0.1",
      "localhost",
      "app.example.com\nKEY=value",
      "app..example.com",
    ]) {
      const f = await fixture();
      expect(
        f.run(["--host", host, "--allow-signup", "owner@example.com", "--prepare-only"]).status,
      ).not.toBe(0);
      await expect(stat(f.destination)).rejects.toThrow();
    }
    const f = await fixture();
    expect(f.run(["--host", "app.example.com", "--prepare-only"]).status).not.toBe(0);
    await expect(stat(f.destination)).rejects.toThrow();
  });

  it("requires verified public signup and builds matching images before starting", async () => {
    const f = await fixture();
    const args = ["--host", "app.example.com", "--allow-signup", "owner@example.com", "--build"];
    expect(f.run(args).status).not.toBe(0);
    expect(await readFile(f.log, "utf8")).not.toContain("up -d");
    const path = join(f.destination, ".env");
    const env = await readFile(path, "utf8");
    await writeFile(
      path,
      env
        .replace("SMTP_URL=\n", "SMTP_URL=smtp://mail.example.com\n")
        .replace("EMAIL_FROM=\n", "EMAIL_FROM=bot@example.com\n"),
    );
    const result = f.run(args);
    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(f.log, "utf8");
    expect(log).toContain("pull postgres data-init caddy");
    expect(log).toContain("up -d --pull never --wait");
    expect(await readFile(path, "utf8")).toContain(
      "RAKAZO_IMAGE=rakazo/app\nRAKAZO_IMAGE_TAG=server",
    );
    expect(await readFile(path, "utf8")).toContain(
      "RAKAZO_COMPUTER_IMAGE=rakazo/computer\nRAKAZO_COMPUTER_IMAGE_TAG=server",
    );
  });

  it("ships a TLS-only public edge and a persistent shared control plane", async () => {
    const overlay = await readFile(resolve("infra/compose/docker-compose.server.yml"), "utf8");
    const base = await readFile(resolve("infra/compose/docker-compose.images.yml"), "utf8");
    expect(overlay).toContain('"443:443"');
    expect(overlay).toContain("caddydata:/data");
    expect(overlay).not.toContain("docker.sock");
    expect(base).toContain('"127.0.0.1:${RAKAZO_API_PORT:-3100}:3100"');
    expect(base).toContain("WAKEUP_DRIVER: graphile");
    expect(base).toContain("pgdata:/var/lib/postgresql/data");
  });
});
