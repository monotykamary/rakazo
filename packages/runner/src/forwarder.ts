import path from "node:path";
import { MACHINE_OFFLINE_AFTER_MS } from "@rakazo/contracts";
import { resolveSupervisorToken } from "@rakazo/core";
import { CommandRejectedError } from "./command-validation.js";
import type { RunnerCredentials } from "./credentials.js";
import { loadCredentials } from "./credentials.js";
import { ForwardJournal } from "./journal.js";
import {
  type ForwardResult,
  forwardToSupervisor,
  SupervisorUnreachableError,
} from "./supervisor-forward.js";
import { type MachineCommand, MachineRevokedError, TunnelClient } from "./tunnel-client.js";

export interface ForwarderOptions {
  credentials: RunnerCredentials;
  /** Runner home for the crash journal (credentials stay in their own file). */
  home: string;
  /** Local supervisor configuration; its token never leaves this machine. */
  supervisor: { baseUrl: string; dataDir: string; token?: string; fetch?: typeof fetch };
  client?: TunnelClient;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  longPollWaitMs?: number;
  maxInFlight?: number;
  log?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LONG_POLL_WAIT_MS = 15_000;
const MAX_POLL_BACKOFF_MS = 30_000;
/** Below the server's offline threshold so a busy runner never looks offline. */
const HEARTBEAT_INTERVAL_MS = Math.floor(MACHINE_OFFLINE_AFTER_MS / 3);
const IDLE_SLEEP_MS = 25;
const MAX_IN_FLIGHT_COMMANDS = 12;
const RESULT_POST_RETRY_MS = 2_000;
const RESULT_POST_ATTEMPTS = 5;

export function supervisorFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = env.RAKAZO_SUPERVISOR_URL?.trim() || "http://127.0.0.1:7091";
  const dataDir = env.RAKAZO_DATA_DIR?.trim();
  if (!dataDir) {
    throw new Error("RAKAZO_DATA_DIR is required: the runner's shared persistent data root");
  }
  // Same secret the local supervisor enforces; never transmitted to the cloud or a model.
  const token = env.RAKAZO_SUPERVISOR_TOKEN?.trim() ?? resolveSupervisorToken(env);
  return { baseUrl, dataDir, token };
}

function jsonResultBody(message: string) {
  return {
    bodyBase64: Buffer.from(JSON.stringify({ error: message })).toString("base64"),
    contentType: "application/json",
  };
}

/** Abortable sleep that never leaks listeners: cleanup removes the abort hook. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
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

export async function runForwarder(options: ForwarderOptions): Promise<void> {
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT_COMMANDS;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError("maxInFlight must be a positive safe integer");
  }
  const log = options.log ?? (() => undefined);
  // One global stop controller: revocation or an external abort stops the poll loop,
  // the heartbeat loop, and every in-flight command immediately.
  const stop = new AbortController();
  const onExternalAbort = () => stop.abort();
  const signal = options.signal ?? stop.signal;
  if (signal !== stop.signal) {
    if (signal.aborted) stop.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const journal = await ForwardJournal.load(path.join(options.home, "journal.jsonl"));
  const client =
    options.client ??
    new TunnelClient({ serverUrl: options.credentials.serverUrl, fetch: options.supervisor.fetch });
  const supervisor = { ...options.supervisor, token: options.supervisor.token ?? "" };
  if (!supervisor.token) throw new Error("The local supervisor token must be configured");

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const longPollWaitMs = options.longPollWaitMs ?? DEFAULT_LONG_POLL_WAIT_MS;
  // Tracked so a graceful stop waits for in-flight commands: their pending HTTP
  // cancels and their journal records flush before runForwarder returns.
  const pendingCommands = new Set<Promise<void>>();
  let backoffMs = pollIntervalMs;
  let loopFailure: unknown;

  const deliverResult = async (
    commandId: string,
    status: number,
    body: { bodyBase64?: string; contentType?: string } = {},
    _expiresAt?: string,
  ) => {
    // Result posts are idempotent (the server accepts exactly one), so a bounded
    // retry closes the lost-connection gap instead of leaving a claimed command
    // hanging until the caller times out.
    for (let attempt = 1; attempt <= RESULT_POST_ATTEMPTS; attempt += 1) {
      if (stop.signal.aborted) return;
      try {
        await client.postResult(
          options.credentials.machineToken,
          commandId,
          {
            status,
            ...(status >= 400 ? { statusText: "tunnel command failed" } : {}),
            ...body,
          },
          stop.signal,
        );
        await journal.markDelivered(commandId);
        return;
      } catch (error) {
        if (error instanceof MachineRevokedError) throw error;
        if (attempt === RESULT_POST_ATTEMPTS) {
          log(
            `result for ${commandId} stays undelivered: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          return;
        }
        await sleep(RESULT_POST_RETRY_MS, stop.signal);
      }
    }
  };

  const failCommand = async (command: MachineCommand, status: number, message: string) => {
    const body = jsonResultBody(message);
    await journal.complete(command.id, status, body.bodyBase64, body.contentType);
    await deliverResult(command.id, status, body, command.expiresAt);
  };

  const handleCommand = async (command: MachineCommand) => {
    const prior = journal.lookup(command.id);
    if (prior?.state === "completed" || prior?.state === "delivered") {
      // The server claims a command exactly once, so this is defensive: an
      // already-handled delivery is answered from the journal, never re-executed.
      await deliverResult(
        command.id,
        prior.status ?? 502,
        {
          ...(prior.bodyBase64 ? { bodyBase64: prior.bodyBase64 } : {}),
          ...(prior.contentType ? { contentType: prior.contentType } : {}),
        },
        command.expiresAt,
      );
      return;
    }
    if (command.expiresAt && Date.now() > Date.parse(command.expiresAt)) {
      await deliverResult(
        command.id,
        504,
        jsonResultBody("command expired before execution"),
        command.expiresAt,
      );
      return;
    }
    if (prior) {
      // Started before a crash: the effect state is unknown, so a mutation must
      // fail closed instead of running twice. Only reads are safe to re-execute.
      if (command.method.toUpperCase() !== "GET") {
        await failCommand(command, 409, "uncertain mutation after runner restart; not replayed");
        return;
      }
    } else {
      await journal.begin(command.id, command.method, command.path);
    }
    let result: ForwardResult;
    try {
      result = await forwardToSupervisor(supervisor, command, stop.signal);
    } catch (error) {
      if (error instanceof CommandRejectedError) {
        await failCommand(command, error.status, error.message);
        return;
      }
      await failCommand(
        command,
        error instanceof SupervisorUnreachableError ? 502 : 500,
        error instanceof Error ? error.message : "command failed",
      );
      return;
    }
    const body = result.body.byteLength
      ? {
          bodyBase64: Buffer.from(result.body).toString("base64"),
          contentType: result.contentType,
        }
      : { bodyBase64: undefined, contentType: undefined };
    await journal.complete(command.id, result.status, body.bodyBase64, result.contentType);
    await deliverResult(command.id, result.status, body, command.expiresAt);
  };

  const heartbeatLoop = (async () => {
    let next = 0;
    while (!stop.signal.aborted) {
      const now = Date.now();
      if (now >= next) {
        try {
          await client.heartbeat(options.credentials.machineToken, stop.signal);
          next = now + HEARTBEAT_INTERVAL_MS;
        } catch (error) {
          if (error instanceof MachineRevokedError) {
            loopFailure ??= error;
            stop.abort();
            return;
          }
          log(`heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}`);
          next = now + HEARTBEAT_INTERVAL_MS;
        }
      }
      await sleep(250, stop.signal);
    }
  })();

  // Results journaled as completed but never acked are re-posted on startup: the
  // result endpoint is idempotent, and expired/unknown commands answer 404/409.
  const recoveryLoop = (async () => {
    for (const entry of journal.pendingResults()) {
      if (stop.signal.aborted) return;
      await deliverResult(entry.deliveryId, entry.status ?? 502, {
        ...(entry.bodyBase64 ? { bodyBase64: entry.bodyBase64 } : {}),
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
      });
    }
  })();

  const pollLoop = (async () => {
    while (!stop.signal.aborted) {
      // Polling claims durable work. Leave it on the server until we can execute it.
      if (pendingCommands.size >= maxInFlight) {
        await Promise.race(pendingCommands);
        continue;
      }
      let command: MachineCommand | null;
      try {
        command = await client.poll(options.credentials.machineToken, longPollWaitMs, stop.signal);
        backoffMs = pollIntervalMs;
      } catch (error) {
        if (error instanceof MachineRevokedError) {
          loopFailure ??= error;
          stop.abort();
          return;
        }
        log(`poll failed: ${error instanceof Error ? error.message : "unknown error"}`);
        await sleep(backoffMs, stop.signal);
        backoffMs = Math.min(MAX_POLL_BACKOFF_MS, backoffMs * 2);
        continue;
      }
      if (stop.signal.aborted) return;
      if (!command) {
        await sleep(IDLE_SLEEP_MS, stop.signal);
        continue;
      }
      const task = handleCommand(command).catch((error) => {
        if (error instanceof MachineRevokedError) {
          loopFailure ??= error;
          stop.abort();
          return;
        }
        log(
          `command ${command.id} handling failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      });
      pendingCommands.add(task);
      void task.finally(() => pendingCommands.delete(task));
    }
  })();

  const loops = [pollLoop, heartbeatLoop, recoveryLoop];
  try {
    await Promise.all(loops);
  } finally {
    // A recovery failure must also cancel polls and drain already-started work.
    stop.abort();
    await Promise.allSettled(loops);
    await Promise.allSettled([...pendingCommands]);
    if (signal !== stop.signal) signal.removeEventListener("abort", onExternalAbort);
  }
  if (loopFailure !== undefined) throw loopFailure;
}

export { loadCredentials };
