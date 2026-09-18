import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createPool,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  retryOnTooManyConnections,
} from "./client.js";

const pools: Array<{ end: () => Promise<void> }> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  vi.restoreAllMocks();
});

describe("createDb", () => {
  it("builds a bounded named pool", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      poolMax: 3,
      applicationName: "rakazo-test",
    });
    pools.push(pool);
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(0);
    expect(pool.options.application_name).toBe("rakazo-test");
  });

  it("defaults to four connections", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    expect(pool.options.max).toBe(4);
  });
});

describe("createPool", () => {
  it("retries callback-style checkouts without changing their release callback", async () => {
    vi.useFakeTimers();
    const client = {} as PoolClient;
    const done = vi.fn();
    let attempts = 0;
    type ConnectCallback = (
      error: Error | undefined,
      connected?: PoolClient,
      release?: (release?: boolean | Error) => void,
    ) => void;
    vi.spyOn(Pool.prototype, "connect").mockImplementation(((callback?: ConnectCallback) => {
      if (!callback) return Promise.reject(new Error("Promise checkout was not expected"));
      attempts += 1;
      queueMicrotask(() => {
        if (attempts === 1) callback(Object.assign(new Error("full"), { code: "53300" }));
        else callback(undefined, client, done);
      });
    }) as Pool["connect"]);
    const pool = createPool("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    const checkout = new Promise<{ client: PoolClient; done: (release?: boolean | Error) => void }>(
      (resolve, reject) => {
        pool.connect((error, connected, release) => {
          if (error) reject(error);
          else if (connected && release) resolve({ client: connected, done: release });
          else reject(new Error("PostgreSQL pool returned no client"));
        });
      },
    );

    await vi.advanceTimersByTimeAsync(200);
    await expect(checkout).resolves.toEqual({ client, done });
    expect(attempts).toBe(2);
  });

  it("reports pool and client errors through the configured callback", () => {
    const onConnectionError = vi.fn();
    const pool = createPool("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      onConnectionError,
    });
    pools.push(pool);
    const client = new EventEmitter();

    pool.emit("connect", client as never);
    const poolError = new Error("idle client lost");
    const clientError = new Error("checked-out client lost");
    pool.emit("error", poolError);
    client.emit("error", clientError);

    expect(onConnectionError).toHaveBeenNthCalledWith(1, poolError);
    expect(onConnectionError).toHaveBeenNthCalledWith(2, clientError);
  });
});

describe("parsePositiveInteger", () => {
  it("accepts positive integers and otherwise falls back", () => {
    expect(parsePositiveInteger(undefined, 8)).toBe(8);
    expect(parsePositiveInteger("0", 8)).toBe(8);
    expect(parsePositiveInteger("2.5", 8)).toBe(8);
    expect(parsePositiveInteger("nope", 8)).toBe(8);
    expect(parsePositiveInteger("6", 8)).toBe(6);
  });
});

describe("isTooManyDatabaseConnections", () => {
  it("recognises Prisma, PostgreSQL, messages, and nested causes", () => {
    expect(isTooManyDatabaseConnections({ code: "P2037" })).toBe(true);
    expect(isTooManyDatabaseConnections({ code: "53300" })).toBe(true);
    expect(isTooManyDatabaseConnections(new Error("Too many database connections opened"))).toBe(
      true,
    );
    const root = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
    expect(isTooManyDatabaseConnections(new Error("pool.connect failed", { cause: root }))).toBe(
      true,
    );
    expect(isTooManyDatabaseConnections(new Error("relation does not exist"))).toBe(false);
  });
});

describe("retryOnTooManyConnections", () => {
  it("retries capacity failures and returns the first success", async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("full"), { code: "53300" }))
      .mockRejectedValueOnce(Object.assign(new Error("full"), { code: "P2037" }))
      .mockResolvedValue("ok");

    await expect(retryOnTooManyConnections(operation, { sleep })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("does not retry unrelated failures", async () => {
    const error = new Error("relation does not exist");
    const operation = vi.fn(async () => {
      throw error;
    });
    await expect(retryOnTooManyConnections(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("interrupts a pending capacity delay when shutdown is requested", async () => {
    const shutdown = new AbortController();
    const waiting = deferred();
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("full"), { code: "53300" });
    });
    const retrying = retryOnTooManyConnections(operation, {
      signal: shutdown.signal,
      sleep: () => {
        waiting.resolve();
        return new Promise(() => undefined);
      },
    });
    await waiting.promise;
    shutdown.abort(new Error("shutdown"));

    await expect(retrying).rejects.toThrow("shutdown");
    expect(operation).toHaveBeenCalledOnce();
  });
});
