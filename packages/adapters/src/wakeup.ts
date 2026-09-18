import {
  type BackgroundJob,
  type BackgroundJobHandlers,
  dispatchBackgroundJob,
  type JobPublisher,
  type JobWorkerHost,
} from "@rakazo/adapter-kit";
import { isTooManyDatabaseConnections } from "@rakazo/db";
import { runCorrelatedJob, unwrapJobPayload, wrapJobPayload } from "@rakazo/logging";
import { makeWorkerUtils, type Runner, run, type WorkerUtils } from "graphile-worker";
import type { Pool } from "pg";

type GraphileConnection = Pool | string;

function graphileConnection(
  connection: GraphileConnection,
): { pgPool: Pool } | { connectionString: string } {
  return typeof connection === "string" ? { connectionString: connection } : { pgPool: connection };
}

export class GraphileJobPublisher implements JobPublisher {
  private utils: Promise<WorkerUtils> | undefined;
  private closed = false;

  constructor(private readonly connection: GraphileConnection) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    const utils = await this.getUtils();
    await utils.addJob(job.name, wrapJobPayload(job.payload), {
      runAt: job.availableAt,
      jobKey: job.replaceKey,
    });
  }

  async cancel(key: string): Promise<void> {
    const utils = await this.getUtils();
    await utils.withPgClient(async (client) => {
      await client.query("select graphile_worker.remove_job($1::text)", [key]);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.utils) await (await this.utils).release();
  }

  private getUtils(): Promise<WorkerUtils> {
    if (this.closed) throw new Error("Background job publisher is closed");
    this.utils ??= makeWorkerUtils(graphileConnection(this.connection));
    return this.utils;
  }
}

export function databaseCapacityBackoffMs(attempt: number): number {
  return Math.min(30_000, 200 * 2 ** Math.min(attempt, 8));
}

export class GraphileJobWorkerHost implements JobWorkerHost {
  private runner: Runner | undefined;
  private handlers: BackgroundJobHandlers | undefined;
  private stopping = false;
  private startTask: Promise<void> | undefined;
  private superviseTask: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;

  constructor(
    private readonly connection: GraphileConnection,
    private readonly options: {
      concurrency?: number;
      pollInterval?: number;
      noHandleSignals?: boolean;
      sleep?: (ms: number) => Promise<void>;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (this.runner || this.superviseTask) return;
    if (this.startTask) return this.startTask;
    this.stopping = false;
    this.handlers = handlers;
    const starting = this.startUntilReady();
    this.startTask = starting;
    try {
      await starting;
    } finally {
      if (this.startTask === starting) this.startTask = undefined;
    }
    if (this.stopping || !this.runner) return;
    const supervising = this.supervise();
    this.superviseTask = supervising;
    void supervising.catch((error) => {
      if (this.options.onError) this.options.onError(error);
      else
        queueMicrotask(() => {
          throw error;
        });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeSleep?.();
    const runner = this.runner;
    try {
      await runner?.stop();
      await this.startTask;
    } finally {
      await this.superviseTask?.catch(() => undefined);
      this.runner = undefined;
      this.startTask = undefined;
      this.superviseTask = undefined;
      this.handlers = undefined;
    }
  }

  private async startUntilReady(): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt += 1) {
      try {
        await this.launchRunner();
        return;
      } catch (error) {
        if (this.stopping) return;
        if (!isTooManyDatabaseConnections(error)) throw error;
        await this.delay(databaseCapacityBackoffMs(attempt));
      }
    }
  }

  private async launchRunner(): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) throw new Error("Background job worker has no handlers");
    const taskList = Object.fromEntries(
      Object.keys(handlers).map((name) => [
        name,
        async (payload: unknown) => {
          const unpacked = unwrapJobPayload(payload);
          await runCorrelatedJob({
            name,
            payload: unpacked.payload,
            correlation: unpacked.correlation,
            run: () => dispatchBackgroundJob(handlers, name, unpacked.payload),
          });
        },
      ]),
    );
    const runner = await run({
      ...graphileConnection(this.connection),
      concurrency: this.options.concurrency ?? 4,
      pollInterval: this.options.pollInterval ?? 500,
      noHandleSignals: this.options.noHandleSignals,
      taskList,
    });
    if (this.stopping) {
      await runner.stop();
      return;
    }
    this.runner = runner;
  }

  private delay(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (this.wakeSleep === wake) this.wakeSleep = undefined;
        if (error === undefined || this.stopping) resolve();
        else reject(error);
      };
      const wake = () => finish();
      this.wakeSleep = wake;
      if (this.options.sleep)
        void Promise.resolve(this.options.sleep(ms)).then(() => finish(), finish);
      else timer = setTimeout(wake, ms);
    });
  }

  private async supervise(): Promise<void> {
    for (;;) {
      const runner = this.runner;
      if (!runner || this.stopping) return;
      try {
        await runner.promise;
        if (this.runner === runner) this.runner = undefined;
        return;
      } catch (error) {
        if (this.stopping) return;
        if (this.runner === runner) this.runner = undefined;
        if (!isTooManyDatabaseConnections(error)) throw error;
        for (let attempt = 0; ; attempt += 1) {
          if (this.stopping) return;
          await this.delay(databaseCapacityBackoffMs(attempt));
          if (this.stopping) return;
          try {
            await this.launchRunner();
            if (this.stopping || !this.runner) return;
            break;
          } catch (startError) {
            if (!isTooManyDatabaseConnections(startError)) throw startError;
          }
        }
      }
    }
  }
}

interface QueuedJob {
  name: BackgroundJob["name"];
  payload: unknown;
  availableAt?: Date;
  replaceKey?: string;
}

function toQueuedJob(job: BackgroundJob): QueuedJob {
  return {
    name: job.name,
    payload: wrapJobPayload(job.payload),
    availableAt: job.availableAt,
    replaceKey: job.replaceKey,
  };
}

export class InMemoryJobQueue implements JobPublisher, JobWorkerHost {
  private handlers: BackgroundJobHandlers | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scheduled = new Map<ReturnType<typeof setTimeout>, QueuedJob>();
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly closingJobs: QueuedJob[] = [];
  private draining: Promise<void> | undefined;
  private closed = false;
  private stopped = false;
  private closing = false;
  private acceptingClosingJobs = false;
  private closeRequested = false;

  async enqueue(job: BackgroundJob): Promise<void> {
    const stored = toQueuedJob(job);
    if (this.closed) throw new Error("Background job publisher is closed");
    if (this.stopped) throw new Error("Background job publisher is stopped");
    if (this.closing) {
      this.enqueueWhileClosing(stored);
      return;
    }
    if (stored.replaceKey) {
      await this.cancel(stored.replaceKey);
      if (this.closed) throw new Error("Background job publisher is closed");
      if (this.stopped) throw new Error("Background job publisher is stopped");
      if (this.closing) {
        this.enqueueWhileClosing(stored);
        return;
      }
    }
    const delay = stored.availableAt ? Math.max(0, stored.availableAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled.delete(timer);
      if (stored.replaceKey && this.keyed.get(stored.replaceKey) === timer) {
        this.keyed.delete(stored.replaceKey);
      }
      const handlers = this.handlers;
      if (!handlers) return;
      void this.dispatch(handlers, stored);
    }, delay);
    this.timers.add(timer);
    this.scheduled.set(timer, stored);
    if (stored.replaceKey) this.keyed.set(stored.replaceKey, timer);
  }

  async cancel(replaceKey: string): Promise<void> {
    const closing = this.closingJobs.findIndex((job) => job.replaceKey === replaceKey);
    if (closing >= 0) this.closingJobs.splice(closing, 1);
    const timer = this.keyed.get(replaceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.keyed.delete(replaceKey);
    this.timers.delete(timer);
    this.scheduled.delete(timer);
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
  }

  async stop(): Promise<void> {
    await this.drain();
  }

  private dispatch(handlers: BackgroundJobHandlers, job: QueuedJob): Promise<void> {
    const unpacked = unwrapJobPayload(job.payload);
    const active = runCorrelatedJob({
      name: job.name,
      payload: unpacked.payload,
      correlation: unpacked.correlation,
      run: () => dispatchBackgroundJob(handlers, job.name, unpacked.payload),
    }).catch(() => undefined);
    this.active.add(active);
    void active.finally(() => this.active.delete(active));
    return active;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeRequested = true;
    await this.drain();
  }

  private enqueueWhileClosing(job: QueuedJob): void {
    if (job.replaceKey) {
      const existing = this.closingJobs.findIndex((queued) => queued.replaceKey === job.replaceKey);
      if (existing >= 0) this.closingJobs.splice(existing, 1);
    }
    if (job.availableAt && job.availableAt.getTime() > Date.now()) {
      // Delayed in-memory jobs are intentionally discarded on shutdown; durable
      // schedulers reconcile them after restart. Never run them early.
      return;
    }
    if (!this.acceptingClosingJobs) throw new Error("Background job publisher is closing");
    this.closingJobs.push(job);
  }

  private async drain(): Promise<void> {
    if (this.draining) return this.draining;
    const draining = this.performDrain();
    this.draining = draining;
    try {
      await draining;
    } finally {
      if (this.draining === draining) this.draining = undefined;
    }
  }

  private async performDrain(): Promise<void> {
    this.closing = true;
    this.acceptingClosingJobs = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      const job = this.scheduled.get(timer);
      if (job) this.enqueueWhileClosing(job);
    }
    this.timers.clear();
    this.scheduled.clear();
    this.keyed.clear();
    await Promise.all(this.active);
    this.acceptingClosingJobs = false;
    const handlers = this.handlers;
    const closingJobs = this.closingJobs.splice(0);
    if (!handlers && closingJobs.length > 0) {
      throw new Error("Background job publisher is closing");
    }
    if (handlers) {
      for (const job of closingJobs) void this.dispatch(handlers, job);
    }
    await Promise.all(this.active);
    this.handlers = undefined;
    this.closed = this.closeRequested;
    this.stopped = !this.closeRequested;
    this.closing = false;
  }
}
