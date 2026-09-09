import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createProxyServer } from "portless";
import { afterEach, describe, expect, it } from "vitest";
import { viteDevNetwork } from "../../../apps/web/portless";
import {
  callerEnvironment,
  devMain,
  resolvedWorkerEnvironment,
  resolvePi,
  serviceUrls,
} from "../../../scripts/dev.mjs";
import {
  PORTLESS_CHILD,
  portlessLaunchPlan,
  portlessPublicOrigin,
  portlessServiceEnvironment,
  portlessWorkerEnvironment,
  shouldBootstrapPortless,
} from "../../../scripts/dev-portless.mjs";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function listen(server: ReturnType<typeof createServer>, port = 0) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("Portless dev bootstrap", () => {
  it("wraps only interactive source service startup and cannot recurse", () => {
    expect(shouldBootstrapPortless([], {})).toBe(true);
    for (const env of [
      { PORTLESS: "0" },
      { PORTLESS: "false" },
      { PORTLESS: "skip" },
      { CI: "1" },
      { NODE_ENV: "production" },
      { RAKAZO_DEPLOY_DIR: "/deployment" },
    ])
      expect(shouldBootstrapPortless([], env)).toBe(false);
    for (const arg of ["--help", "--pi", "--setup-kit"])
      expect(shouldBootstrapPortless([arg], {})).toBe(false);
    expect(shouldBootstrapPortless([], { PORTLESS_URL: "https://rakazo.localhost" })).toBe(false);
    expect(() => shouldBootstrapPortless([], { [PORTLESS_CHILD]: "1" })).toThrow("did not provide");
  });

  it("rejects a stored production configuration before invoking Portless", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-portless-managed-"));
    temporary.push(root);
    await writeFile(path.join(root, ".env"), "NODE_ENV=production\n");
    await expect(devMain({ root, args: [], inherited: {} })).rejects.toThrow(
      "Refusing source dev startup",
    );
  });

  it("pins the reviewed dependency and registers the offline suite", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.devDependencies.portless).toBe("0.15.6");
    expect(pkg.scripts.dev).toBe("node scripts/dev.mjs");
    expect(pkg.scripts["test:dev"]).toContain("dev-portless.test.ts");
  });

  it("uses the pinned CLI directly and captures the caller PATH before forwarding", () => {
    const root = path.resolve("/checkout");
    const inherited = {
      npm_config_user_agent: "bun/1.4.2",
      npm_config_local_prefix: root,
      PATH: [
        path.join(root, "node_modules", ".bin"),
        path.join(root, "node_modules", ".bin"),
        path.join(path.dirname(root), "node_modules", ".bin"),
        "/caller/bin",
      ].join(path.delimiter),
      PORT: "8123",
    };
    const caller = callerEnvironment(root, inherited);
    const plan = portlessLaunchPlan(root, ["--trust-local-pi"], caller, "/runtime/node");
    expect(plan.command).toBe("/runtime/node");
    expect(plan.args).toEqual([
      path.join(root, "node_modules", "portless", "dist", "cli.js"),
      "run",
      "--name",
      "rakazo",
      "/runtime/node",
      path.join(root, "scripts", "dev.mjs"),
      "--trust-local-pi",
    ]);
    expect(plan.environment.PATH).toBe("/caller/bin");
    expect(plan.environment.RAKAZO_DEV_PI_PATH).toBe("/caller/bin");
  });

  it("projects the public origin only into services and restores worker launch inputs", () => {
    const base = {
      PORT: "8123",
      HOST: "custom-before-wrapper",
      WEB_ORIGIN: "http://internal-before-wrapper:5173",
      BETTER_AUTH_URL: "http://internal-before-wrapper:5173",
      PATH: "/caller/bin",
    };
    const launch = portlessLaunchPlan("/checkout", [], base, "/runtime/node");
    const child = {
      ...launch.environment,
      PORT: "4567",
      HOST: "127.0.0.1",
      PORTLESS_URL: "https://branch.rakazo.test",
      NODE_EXTRA_CA_CERTS: "/portless/ca.pem",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".test",
      PATH: `/portless/bin${path.delimiter}/caller/bin`,
    };
    expect(portlessPublicOrigin(child)).toBe("https://branch.rakazo.test");
    const service = portlessServiceEnvironment(child);
    expect(service).toMatchObject({
      PORT: "4567",
      WEB_PORT: "4567",
      WEB_ORIGIN: "https://branch.rakazo.test",
      BETTER_AUTH_URL: "https://branch.rakazo.test",
    });
    expect(service).not.toHaveProperty("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS");
    expect(service).not.toHaveProperty(PORTLESS_CHILD);
    expect(child.WEB_ORIGIN).toBe(base.WEB_ORIGIN);
    const worker = portlessWorkerEnvironment(child);
    expect(worker).toEqual({
      ...base,
      RAKAZO_DEV_PI_PATH: "/caller/bin",
    });
    expect(
      portlessWorkerEnvironment({
        ...child,
        PORT: "4999",
        PATH: `/another/portless/bin${path.delimiter}/caller/bin`,
      }),
    ).toEqual(worker);
    expect(() => portlessServiceEnvironment({ PORT: "0", PORTLESS_URL: "bad" })).toThrow();
  });

  it("keeps the isolated profile chosen by Pi resolution in the worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-portless-profile-"));
    temporary.push(root);
    const command = path.join(root, "data/dev/pi/node_modules/.bin/pi");
    const profile = path.join(root, "data/dev/pi/agent");
    await mkdir(path.dirname(command), { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(path.join(profile, "settings.json"), "{}");
    const values = { RAKAZO_PI_COMMAND: command, PATH: "/caller/bin" };
    const resolved: Record<string, string> = { ...values };
    resolved.RAKAZO_PI_COMMAND = await resolvePi(root, resolved, new Set(), {
      run() {
        throw new Error("Unexpected install");
      },
    });
    const worker = resolvedWorkerEnvironment(root, values, resolved);
    expect(worker.PI_CODING_AGENT_DIR).toBe(profile);
    expect(worker.RAKAZO_PI_COMMAND).toBe(command);
    expect(values).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });

  it.skipIf(process.platform === "win32")(
    "retains a controlling terminal for first-run permission prompts",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-portless-tty-"));
      temporary.push(root);
      const probe = path.join(root, "probe.mjs");
      const module = new URL("../../../scripts/dev.mjs", import.meta.url).href;
      const child =
        "const fs=require('node:fs');const fd=fs.openSync('/dev/tty','r');fs.closeSync(fd);console.log('controlling-terminal-ok');";
      await writeFile(
        probe,
        `import {runPortless} from ${JSON.stringify(module)}; process.exitCode=await runPortless({command:process.execPath,args:['-e',${JSON.stringify(child)}],root:process.cwd(),environment:process.env});`,
      );
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const log = path.join(root, "tty.log");
      const args =
        process.platform === "darwin"
          ? ["-q", log, process.execPath, probe]
          : ["-q", "-e", "-c", `${quote(process.execPath)} ${quote(probe)}`, log];
      const result = spawnSync("script", args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("controlling-terminal-ok");
    },
  );

  it("uses internal listener URLs for preflight and readiness", () => {
    expect(
      serviceUrls({
        API_PORT: "3199",
        WEB_PORT: "4567",
        WEB_ORIGIN: "https://rakazo.localhost",
      }).map((url) => url.href),
    ).toEqual(["http://127.0.0.1:3199/health", "http://127.0.0.1:4567/"]);
  });

  it("scopes Vite host and HMR settings to the exact public URL", () => {
    expect(viteDevNetwork({ PORT: "4567", PORTLESS_URL: "https://branch.rakazo.test" })).toEqual({
      port: 4567,
      allowedHosts: ["branch.rakazo.test"],
      hmr: { protocol: "wss", host: "branch.rakazo.test", clientPort: 443 },
    });
    expect(viteDevNetwork({ WEB_PORT: "5174" })).toEqual({ port: 5174 });
    expect(viteDevNetwork({ PORT: "3100", WEB_PORT: "5174" })).toEqual({ port: 5174 });
    expect(() => viteDevNetwork({ PORTLESS_URL: "https://rakazo.localhost" })).toThrow("PORT");
  });

  it("forwards the captured Pi PATH through a real nested bun x tsx", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-portless-path-"));
    temporary.push(root);
    const probe = path.join(root, "probe.ts");
    await writeFile(
      probe,
      "if (process.env.RAKAZO_DEV_PI_PATH !== process.env.EXPECTED_PATH) process.exit(9); console.log('forwarded');\n",
    );
    const plan = portlessLaunchPlan(
      process.cwd(),
      [],
      { PATH: process.env.PATH, RAKAZO_DEV_PI_PATH: "/caller/bin:/system/bin" },
      process.execPath,
    );
    const result = spawnSync("bun", ["x", "tsx", probe], {
      cwd: path.join(process.cwd(), "apps/api"),
      env: {
        ...plan.environment,
        EXPECTED_PATH: "/caller/bin:/system/bin",
        PATH: [path.join(process.cwd(), "node_modules", ".bin"), process.env.PATH].join(
          path.delimiter,
        ),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("forwarded");
  });

  it("proxies an isolated request without TLS, state, trust, sudo, or hosts changes", async () => {
    const upstream = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }));
    });
    let proxy: ReturnType<typeof createProxyServer> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      proxy = createProxyServer({
        proxyPort: 0,
        getRoutes: () => [{ hostname: "rakazo.localhost", port: upstreamPort }],
      });
      const proxyPort = await listen(proxy as ReturnType<typeof createServer>);
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: "/api/probe",
            headers: { host: "rakazo.localhost", origin: "https://rakazo.localhost" },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        outgoing.once("error", reject);
        outgoing.end();
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        host: "rakazo.localhost",
        origin: "https://rakazo.localhost",
      });
    } finally {
      if (proxy?.listening) await close(proxy as ReturnType<typeof createServer>);
      if (upstream.listening) await close(upstream);
    }
  });
});
