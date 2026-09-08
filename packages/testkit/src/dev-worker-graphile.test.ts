import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GraphileJobWorkerHost } from "../../adapters/src/wakeup";

// Stub only database/bootstrap and cron boundaries. The host, run(), Runner.stop,
// pool shutdown, worker.release and graceful-shutdown abort timer are installed code.
const require = createRequire(path.resolve("packages/adapters/package.json"));
const dist = path.dirname(require.resolve("graphile-worker"));
const main = require(path.join(dist, "main.js"));
const lib = require(path.join(dist, "lib.js"));
const cron = require(path.join(dist, "cron.js"));
const getJobs = require(path.join(dist, "sql/getJobs.js"));
const completeJobs = require(path.join(dist, "sql/completeJobs.js"));
const failJobs = require(path.join(dist, "sql/failJobs.js"));
afterEach(() => vi.restoreAllMocks());

it("real Graphile host stop retains the active handler past gracefulShutdownAbortTimeout", async () => {
  const settled = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const dispose = vi.fn();
  let callbackCount = 0;
  let taskFinished = false;
  const bridge = () => ++callbackCount;
  const handler = vi.fn(async () => {
    started.resolve();
    await settled.promise;
    taskFinished = true;
  });
  let claimed = false;
  vi.spyOn(getJobs, "batchGetJobs").mockImplementation(async () => {
    if (claimed) return [];
    claimed = true;
    return [
      {
        id: "offline-job",
        task_identifier: "messaging.deliver",
        payload: { runId: "fake-run" },
        attempts: 1,
        max_attempts: 3,
      },
    ];
  });
  const complete = vi.spyOn(completeJobs, "batchCompleteJobs").mockResolvedValue([]);
  const fail = vi
    .spyOn(failJobs, "batchFailJobs")
    .mockRejectedValue(new Error("Unexpected failed job"));
  const cronDone = Promise.withResolvers<void>();
  vi.spyOn(cron, "runCron").mockReturnValue({
    _active: true,
    promise: cronDone.promise,
    release: async () => {
      cronDone.resolve();
    },
  });
  vi.spyOn(cron, "getParsedCronItemsFromOptions").mockResolvedValue([]);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    scope: () => logger,
  };
  const withPgClient = Object.assign(
    () => {
      throw new Error("Offline probe attempted SQL");
    },
    {
      withRetries: () => {
        throw new Error("Offline probe attempted SQL retry");
      },
    },
  );
  const compiled = {
    resolvedPreset: {
      worker: {
        concurrentJobs: 1,
        pollInterval: 5,
        gracefulShutdownAbortTimeout: 25,
        localQueue: { size: -1 },
      },
    },
    _rawOptions: { noHandleSignals: true },
    hooks: { process: async () => {} },
    middleware: {
      run: (_name: string, event: unknown, next: (value: unknown) => unknown) => next(event),
      runSync: (_name: string, event: unknown, next: (value: unknown) => unknown) => next(event),
    },
    logger,
    events: new EventEmitter(),
    releasers: [],
    withPgClient,
    workerSchema: "graphile_worker",
    escapedWorkerSchema: '"graphile_worker"',
  };
  let pool: ReturnType<typeof main._runTaskList>;
  vi.spyOn(main, "runTaskListInternal").mockImplementation((_compiled: unknown, tasks: unknown) => {
    pool = main._runTaskList(compiled, tasks, withPgClient, { concurrency: 1, continuous: true });
    return pool;
  });
  vi.spyOn(lib, "getUtilsAndReleasersFromOptions").mockImplementation(async (options: unknown) => [
    { ...compiled, _rawOptions: options },
    async () => {},
  ]);
  const host = new GraphileJobWorkerHost("postgres://fake:fake@127.0.0.1/offline", {
    noHandleSignals: true,
  });
  await host.start({ "messaging.deliver": handler } as never);
  await started.promise;
  let stopped = false;
  const stopping = host.stop().then(() => {
    stopped = true;
    dispose();
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pool.abortSignal.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(taskFinished).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(bridge()).toBe(1);
    expect(bridge()).toBe(2);
    // The adapter passes the validated payload, never Graphile's abort helpers.
    expect(handler).toHaveBeenCalledWith({ runId: "fake-run" });
  } finally {
    settled.resolve();
    await stopping;
  }
  expect(taskFinished).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});
