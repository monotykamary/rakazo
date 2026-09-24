import { type OfficeReplicaWork, OfficeReplicaWorkSchema } from "@rakazo/contracts";
import type { RunnerCredentials } from "./credentials.js";
import type { ReplicaDriver } from "./replica-driver.js";
import { ReplicaJournal } from "./replica-journal.js";
import { MachineRevokedError, type TunnelClient } from "./tunnel-client.js";

export interface ReplicaLoopOptions {
  credentials: RunnerCredentials;
  home: string;
  client: TunnelClient;
  driver: ReplicaDriver;
  signal: AbortSignal;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runReplicaLoop(options: ReplicaLoopOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const token = options.credentials.machineToken;
  let backoff = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const active = new Set<Promise<void>>();

  while (!options.signal.aborted) {
    try {
      const work = await options.client.claimReplica(token, options.signal);
      backoff = options.pollIntervalMs ?? DEFAULT_POLL_MS;
      if (!work) {
        await sleep(backoff, options.signal);
        continue;
      }
      const running = driveReplica(options, work).catch((error) => {
        log(
          `replica ${work.replicaId} failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      });
      active.add(running);
      void running.finally(() => active.delete(running));
    } catch (error) {
      if (error instanceof MachineRevokedError) throw error;
      if (options.signal.aborted) return;
      log(`replica claim failed: ${error instanceof Error ? error.message : "unknown"}`);
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      await sleep(backoff, options.signal);
    }
  }
  await Promise.allSettled([...active]);
}

async function driveReplica(options: ReplicaLoopOptions, work: OfficeReplicaWork): Promise<void> {
  const journal = await ReplicaJournal.load(options.home, work.replicaId);
  const token = options.credentials.machineToken;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  const flush = async () => {
    const batch = journal.unflushed();
    if (!batch.length) return;
    let delay = 1_000;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const cursor = await options.client.postReplicaJournal(
          token,
          { replicaId: work.replicaId, epoch: work.epoch, entries: batch },
          controller.signal,
        );
        journal.markFlushed(cursor);
        return;
      } catch (error) {
        if (error instanceof MachineRevokedError) throw error;
        if (controller.signal.aborted) return;
        await sleep(delay, controller.signal);
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      }
    }
  };
  const sink = {
    async event(type: string, payload: Record<string, unknown>) {
      await journal.append("event", { type, ...payload });
      await flush();
    },
    async heartbeat() {
      await journal.append("heartbeat", { runId: work.runId });
      await flush();
    },
  };
  try {
    const outcome = await options.driver.run(work, sink, controller.signal);
    await journal.append("run_status", { outcome });
    await flush();
    await options.client.returnReplica(
      token,
      { replicaId: work.replicaId, epoch: work.epoch, outcome },
      controller.signal,
    );
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

export function parseReplicaWork(value: unknown): OfficeReplicaWork | null {
  const parsed = OfficeReplicaWorkSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
