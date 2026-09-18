import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { Runner, WorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const graphile = vi.hoisted(() => ({
  run: vi.fn(),
  makeWorkerUtils: vi.fn(),
}));

vi.mock("graphile-worker", () => graphile);

import {
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return { "run.continue": vi.fn(async () => undefined) } as unknown as BackgroundJobHandlers;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mockRunner() {
  const life = deferred();
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => life.resolve()),
  } as unknown as Runner;
  return { runner, resolve: life.resolve, reject: life.reject };
}

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

afterEach(() => {
  vi.useRealTimers();
  graphile.run.mockReset();
  graphile.makeWorkerUtils.mockReset();
});

describe("GraphileJobPublisher pool ownership", () => {
  it("uses the caller pool and releases Graphile without ending that pool", async () => {
    const pool = { end: vi.fn() } as unknown as Pool;
    const release = vi.fn(async () => undefined);
    const addJob = vi.fn(async () => undefined);
    graphile.makeWorkerUtils.mockResolvedValue({ addJob, release } as unknown as WorkerUtils);
    const publisher = new GraphileJobPublisher(pool);

    await publisher.enqueue({ name: "run.continue", payload: { runId: "run-1" } });
    await publisher.close();

    expect(graphile.makeWorkerUtils).toHaveBeenCalledWith({ pgPool: pool });
    expect(addJob).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("keeps the connection-string constructor compatible", async () => {
    graphile.makeWorkerUtils.mockResolvedValue({
      addJob: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    } as unknown as WorkerUtils);
    const publisher = new GraphileJobPublisher("postgres://offline/example");

    await publisher.enqueue({ name: "run.continue", payload: { runId: "run-1" } });
    expect(graphile.makeWorkerUtils).toHaveBeenCalledWith({
      connectionString: "postgres://offline/example",
    });
    await publisher.close();
  });
});

describe("databaseCapacityBackoffMs", () => {
  it("is exponential and capped", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobWorkerHost lifecycle", () => {
  it("retries an initial capacity failure and starts the runner", async () => {
    const ready = mockRunner();
    graphile.run.mockRejectedValueOnce(tooMany).mockResolvedValueOnce(ready.runner);
    const sleep = vi.fn(async () => undefined);
    const pool = {} as Pool;
    const host = new GraphileJobWorkerHost(pool, { concurrency: 2, sleep });

    await host.start(handlers());

    expect(graphile.run).toHaveBeenCalledTimes(2);
    expect(graphile.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ pgPool: pool, concurrency: 2 }),
    );
    expect(sleep).toHaveBeenCalledWith(200);
    await host.stop();
    expect(ready.runner.stop).toHaveBeenCalledOnce();
  });

  it("backs off and restarts after a running worker loses capacity", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    graphile.run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(recovered.runner);
    const sleep = vi.fn(async () => undefined);
    const host = new GraphileJobWorkerHost({} as Pool, { sleep });

    await host.start(handlers());
    first.reject(tooMany);
    await vi.waitFor(() => expect(graphile.run).toHaveBeenCalledTimes(2));

    expect(sleep).toHaveBeenCalledWith(200);
    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalledOnce();
  });

  it("reports unrelated runner failures without restarting", async () => {
    const first = mockRunner();
    graphile.run.mockResolvedValueOnce(first.runner);
    const onError = vi.fn();
    const host = new GraphileJobWorkerHost({} as Pool, { onError });
    await host.start(handlers());

    const error = new Error("runner exploded");
    first.reject(error);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));

    expect(graphile.run).toHaveBeenCalledOnce();
    await host.stop();
  });

  it("clears the real retry timer when shutdown cancels startup", async () => {
    vi.useFakeTimers();
    graphile.run.mockRejectedValueOnce(tooMany);
    const host = new GraphileJobWorkerHost({} as Pool);
    const starting = host.start(handlers());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await host.stop();
    await starting;
    expect(vi.getTimerCount()).toBe(0);
    expect(graphile.run).toHaveBeenCalledOnce();
  });

  it("interrupts an initial retry delay during stop", async () => {
    graphile.run.mockRejectedValueOnce(tooMany);
    const sleeping = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleeping.resolve();
        return new Promise(() => undefined);
      },
    });

    const starting = host.start(handlers());
    await sleeping.promise;
    await host.stop();
    await starting;

    expect(graphile.run).toHaveBeenCalledOnce();
  });

  it("interrupts a post-start restart delay during stop", async () => {
    const first = mockRunner();
    graphile.run.mockResolvedValueOnce(first.runner);
    const sleeping = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleeping.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.reject(tooMany);
    await sleeping.promise;

    await host.stop();
    expect(graphile.run).toHaveBeenCalledOnce();
  });
});
