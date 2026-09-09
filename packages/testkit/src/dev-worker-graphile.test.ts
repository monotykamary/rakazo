import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, expect, it, vi } from "vitest";

// Stub only database/bootstrap and cron boundaries. The host, run(), Runner.stop,
// pool shutdown, worker.release and graceful-shutdown abort timer are installed code.
const require = createRequire(path.resolve("packages/adapters/package.json"));
const dist = path.dirname(realpathSync(require.resolve("graphile-worker")));
const boundaries = {
  "main.js": { runTaskListInternal: vi.fn() },
  "lib.js": { getUtilsAndReleasersFromOptions: vi.fn() },
  "cron.js": { runCron: vi.fn(), getParsedCronItemsFromOptions: vi.fn() },
  "sql/getJobs.js": { batchGetJobs: vi.fn() },
  "sql/completeJobs.js": { batchCompleteJobs: vi.fn() },
  "sql/failJobs.js": { batchFailJobs: vi.fn() },
};
const boundaryUrls = new Map(
  Object.entries(boundaries).map(([file, mocks]) => [
    pathToFileURL(path.join(dist, file)).href,
    mocks,
  ]),
);
const boundaryKey = Symbol.for("rakazo.offlineGraphileBoundaries");
Reflect.set(globalThis, boundaryKey, boundaryUrls);

// Native ESM exports cannot be spied on, and Vitest 5 does not mock imports
// within node_modules. Native loader wrappers replace only the named boundaries;
// every other export is re-exported from the unmodified installed module.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (boundaryUrls.has(resolved.url)) {
      return { ...resolved, url: `${resolved.url}?rakazo-offline-boundary` };
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    if (!url.endsWith("?rakazo-offline-boundary")) return nextLoad(url, context);
    const original = url.slice(0, -"?rakazo-offline-boundary".length);
    const mocks = boundaryUrls.get(original)!;
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `export * from ${JSON.stringify(`${original}?rakazo-offline-actual`)};`,
        `const mocks = globalThis[Symbol.for("rakazo.offlineGraphileBoundaries")].get(${JSON.stringify(original)});`,
        ...Object.keys(mocks).map((name) => `export const ${name} = mocks.${name};`),
      ].join("\n"),
    };
  },
});
const main = await import(path.join(dist, "main.js"));
const lib = boundaries["lib.js"];
const cron = boundaries["cron.js"];
const getJobs = boundaries["sql/getJobs.js"];
const completeJobs = boundaries["sql/completeJobs.js"];
const failJobs = boundaries["sql/failJobs.js"];
const { GraphileJobWorkerHost } = await import("../../adapters/src/wakeup");
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, boundaryKey);
});

it("real Graphile host stop retains the active handler past gracefulShutdownAbortTimeout", async () => {
  const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Offline probe attempted a network connection");
  });
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
  vi.mocked(getJobs.batchGetJobs).mockImplementation(async () => {
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
  const complete = vi.mocked(completeJobs.batchCompleteJobs).mockResolvedValue([]);
  const fail = vi
    .mocked(failJobs.batchFailJobs)
    .mockRejectedValue(new Error("Unexpected failed job"));
  const cronDone = Promise.withResolvers<void>();
  vi.mocked(cron.runCron).mockReturnValue({
    _active: true,
    promise: cronDone.promise,
    release: async () => {
      cronDone.resolve();
    },
  });
  vi.mocked(cron.getParsedCronItemsFromOptions).mockResolvedValue([]);
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
  vi.mocked(main.runTaskListInternal).mockImplementation((_compiled: unknown, tasks: unknown) => {
    pool = main._runTaskList(compiled, tasks, withPgClient, { concurrency: 1, continuous: true });
    return pool;
  });
  vi.mocked(lib.getUtilsAndReleasersFromOptions).mockImplementation(async (options: unknown) => [
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
  expect(fail).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
