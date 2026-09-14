import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Mocker's Docker Engine API socket (`mocker serve` default). */
export function mockerDockerSocket(home: string): string {
  return path.join(home, ".docker", "run", "docker.sock");
}

export function mockerDockerHost(home: string): string {
  return `unix://${mockerDockerSocket(home)}`;
}

/**
 * Point leftover Docker-API clients at Mocker on macOS when `mocker serve` is up.
 * Leaves an explicit `DOCKER_HOST` alone. Does not start `mocker serve`.
 */
export function applyLocalContainerEnv(
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    socketExists?: (socket: string) => boolean;
  } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  if (env.DOCKER_HOST || platform !== "darwin") return env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const socket = mockerDockerSocket(home);
  const present = (options.socketExists ?? existsSync)(socket);
  if (!present) return env;
  env.DOCKER_HOST = mockerDockerHost(home);
  env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
  return env;
}

export type MockerPostgres = {
  connectionUri: string;
  name: string;
  getDatabase(): string;
  getUsername(): string;
  exec(command: string[]): Promise<{ exitCode: number }>;
  stop(): Promise<void>;
};

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForMockerReady(name: string, user: string, database: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await execFileAsync("mocker", ["exec", name, "pg_isready", "-U", user, "-d", database], {
        timeout: 5000,
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("Mocker Postgres did not become ready");
}

/** Throwaway Postgres via `mocker`, matching `bun run dev` on macOS. */
export async function startMockerPostgres(): Promise<MockerPostgres> {
  const name = `rakazo-e2e-${crypto.randomUUID().slice(0, 8)}-postgres`;
  const user = "rakazo";
  const password = "rakazo";
  const database = "rakazo";
  const port = await freeLoopbackPort();
  await execFileAsync("mocker", [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${port}:5432`,
    "--env",
    `POSTGRES_USER=${user}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${database}`,
    "postgres:16",
  ]);
  try {
    await waitForMockerReady(name, user, database);
  } catch (error) {
    await execFileAsync("mocker", ["rm", "-f", name]).catch(() => undefined);
    throw error;
  }
  return {
    name,
    connectionUri: `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    getDatabase: () => database,
    getUsername: () => user,
    async exec(command) {
      try {
        await execFileAsync("mocker", ["exec", name, ...command]);
        return { exitCode: 0 };
      } catch {
        return { exitCode: 1 };
      }
    },
    async stop() {
      await execFileAsync("mocker", ["rm", "-f", name]);
    },
  };
}
