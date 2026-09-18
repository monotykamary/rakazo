import { PrismaPg } from "@prisma/adapter-pg";
import { getLogger } from "@rakazo/logging";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
  signal?: AbortSignal;
  onConnectionError?: (error: Error) => void;
}

const DEFAULT_POOL_MAX = 4;
const CONNECT_RETRY_ATTEMPTS = 8;

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    keepAlive: true,
  });
  const reportError =
    options.onConnectionError ??
    ((error: Error) => {
      getLogger().error("PostgreSQL pool connection error", error);
    });
  pool.on("error", reportError);
  pool.on("connect", (client) => client.on("error", reportError));
  installConnectRetry(pool, options.signal);
  return pool;
}

export function createDb(
  connectionString: string,
  options: DbClientOptions = {},
): { prisma: PrismaClient; pool: Pool } {
  const pool = createPool(connectionString, options);
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}

export function isTooManyDatabaseConnections(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (code === "P2037" || code === "53300") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Too many database connections opened") ||
      message.includes("sorry, too many clients already")
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function retryOnTooManyConnections<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONNECT_RETRY_ATTEMPTS;
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      if (!isTooManyDatabaseConnections(error) || attempt >= attempts - 1) throw error;
      await retryDelay(Math.min(5_000, 200 * 2 ** attempt), options.sleep, options.signal);
    }
  }
}

type ConnectCallback = (
  err: Error | undefined,
  client?: PoolClient,
  done?: (release?: boolean | Error) => void,
) => void;

function installConnectRetry(pool: Pool, signal?: AbortSignal): void {
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    if (!callback) return retryOnTooManyConnections(() => originalConnect(), { signal });
    void retryOnTooManyConnections(
      () =>
        new Promise<{ client: PoolClient; done: (release?: boolean | Error) => void }>(
          (resolve, reject) => {
            originalConnect((error, client, done) => {
              if (error) reject(error);
              else if (client && done) resolve({ client, done });
              else reject(new Error("PostgreSQL pool returned no client"));
            });
          },
        ),
      { signal },
    ).then(
      ({ client, done }) => callback(undefined, client, done),
      (error: unknown) => callback(asError(error)),
    );
  }

  pool.connect = connect as Pool["connect"];
}

function retryDelay(
  ms: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep ? sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (sleep) void Promise.resolve(sleep(ms)).then(() => finish(), finish);
    else timer = setTimeout(() => finish(), ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Database connection retry aborted");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
