import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ModelCatalogEntry, ModelSelection, ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import {
  BLOCKING_PI_UI_METHODS,
  killOwnedProcessTree,
  LOCAL_PI_MODEL_PROBE_ENV,
  type LocalPiRuntimeOptions,
  localPiChildPort,
  localPiRpcArguments,
  sanitizedLocalPiEnvironment,
} from "./pi-local-runtime.js";
import { record } from "./pi-rpc-protocol.js";
import { JsonPeer } from "./pi-rpc-transport.js";

const PROBE_TIMEOUT_MS = 15_000;
const MAX_PUBLIC_LABEL = 500;

export type PiModelRuntimeErrorCode =
  | "PI_NOT_CONFIGURED"
  | "PI_WORKSPACE_UNAVAILABLE"
  | "PI_START_FAILED"
  | "PI_DISCOVERY_TIMEOUT"
  | "PI_DISCONNECTED"
  | "PI_PROTOCOL_FAILED"
  | "PI_DISCOVERY_FAILED";

export class PiModelRuntimeError extends Error {
  constructor(
    readonly code: PiModelRuntimeErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "PiModelRuntimeError";
  }
}

export type PiModelProfile = {
  catalog: ModelCatalogEntry[];
  profileDefault: ModelSelection | null;
};

export interface PiModelRuntimeService {
  read(signal?: AbortSignal, cwd?: string): Promise<PiModelProfile>;
  validate(selection: ModelSelection, signal?: AbortSignal, cwd?: string): Promise<void>;
  supportsCheckpoint?(checkpoint: unknown): boolean;
}

function publicLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal controls from untrusted Pi labels.
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean ? clean.slice(0, MAX_PUBLIC_LABEL) : undefined;
}

function publicIdentity(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim()) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls without rewriting model identities.
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function modelIdentity(value: unknown): Pick<ModelSelection, "provider" | "modelId"> | null {
  const model = record(value);
  const provider = publicIdentity(model.provider, 100);
  const modelId = publicIdentity(model.id, 300);
  return provider && modelId ? { provider, modelId } : null;
}

function thinkingLevels(value: unknown): ThinkingLevel[] {
  const raw = record(value).levels;
  const levels: unknown[] = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      levels.flatMap((level) => {
        const parsed = ThinkingLevelSchema.safeParse(level);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
}

function catalogEntry(value: unknown, levels: ThinkingLevel[]): ModelCatalogEntry | null {
  const model = record(value);
  const identity = modelIdentity(model);
  if (!identity) return null;
  return {
    provider: identity.provider,
    id: identity.modelId,
    label: publicLabel(model.name) ?? identity.modelId,
    billing: "Pi",
    reasoning: model.reasoning === true,
    thinkingLevels: levels,
  };
}

export function unavailablePiModelRuntime(reason: string): PiModelRuntimeService {
  // Configuration details may contain private paths; never expose the supplied reason.
  void reason;
  return {
    read: async () => {
      throw new PiModelRuntimeError("PI_NOT_CONFIGURED");
    },
    validate: async () => {
      throw new PiModelRuntimeError("PI_NOT_CONFIGURED");
    },
  };
}

export class LocalPiModelRuntimeService implements PiModelRuntimeService {
  private readonly command: string;
  private readonly cwd: string;
  private readonly cwdHash: string;

  constructor(options: LocalPiRuntimeOptions) {
    if (!options.cwd || !isAbsolute(options.cwd)) throw new Error("Local Pi cwd must be absolute");
    if (!options.sessionDir || !isAbsolute(options.sessionDir))
      throw new Error("Local Pi sessionDir must be absolute");
    if (options.command !== undefined && !options.command.trim())
      throw new Error("Local Pi command must not be empty");
    this.command = options.command?.trim() || "pi";
    this.cwd = resolve(options.cwd);
    this.cwdHash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 24);
  }

  supportsCheckpoint(checkpoint: unknown): boolean {
    const value = record(checkpoint);
    return value.runtime === "pi-local" && value.cwdHash === this.cwdHash;
  }

  async read(signal?: AbortSignal, cwd?: string): Promise<PiModelProfile> {
    return this.probe(
      async (peer, probeSignal) => {
        const [availableValue, stateValue] = await Promise.all([
          peer.request("get_available_models", {}, probeSignal),
          peer.request("get_state", {}, probeSignal),
        ]);
        const state = record(stateValue);
        const current = modelIdentity(state.model);
        const currentThinking = ThinkingLevelSchema.safeParse(state.thinkingLevel);
        const profileDefault = current
          ? {
              ...current,
              thinkingLevel: currentThinking.success ? currentThinking.data : null,
            }
          : null;
        const availableModels = record(availableValue).models;
        if (!Array.isArray(availableModels)) throw new PiModelRuntimeError("PI_PROTOCOL_FAILED");
        const values: unknown[] = availableModels;
        const catalog: ModelCatalogEntry[] = [];
        const seen = new Set<string>();
        for (const value of values) {
          const identity = modelIdentity(value);
          if (!identity) continue;
          const key = `${identity.provider}\u0000${identity.modelId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await peer.request(
            "set_model",
            { provider: identity.provider, modelId: identity.modelId },
            probeSignal,
          );
          const levels = thinkingLevels(
            await peer.request("get_available_thinking_levels", {}, probeSignal),
          );
          const entry = catalogEntry(value, levels);
          if (entry) catalog.push(entry);
        }
        return { catalog, profileDefault };
      },
      signal,
      cwd,
    );
  }

  async validate(selection: ModelSelection, signal?: AbortSignal, cwd?: string): Promise<void> {
    await this.probe(
      async (peer, probeSignal) => {
        try {
          await peer.request(
            "set_model",
            { provider: selection.provider, modelId: selection.modelId },
            probeSignal,
          );
          const levels = thinkingLevels(
            await peer.request("get_available_thinking_levels", {}, probeSignal),
          );
          if (selection.thinkingLevel !== null && !levels.includes(selection.thinkingLevel)) {
            throw new Error("Reasoning level is unavailable in Pi");
          }
          if (selection.thinkingLevel !== null) {
            await peer.request(
              "set_thinking_level",
              { level: selection.thinkingLevel },
              probeSignal,
            );
          }
          const state = record(await peer.request("get_state", {}, probeSignal));
          const effective = modelIdentity(state.model);
          if (
            effective?.provider !== selection.provider ||
            effective.modelId !== selection.modelId ||
            (selection.thinkingLevel !== null && state.thinkingLevel !== selection.thinkingLevel)
          ) {
            throw new Error("Pi did not acknowledge the model selection");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "Reasoning level is unavailable in Pi") {
            throw error;
          }
          throw new Error("Model is unavailable in Pi", { cause: error });
        }
      },
      signal,
      cwd,
    );
  }

  private async probeCwd(cwd?: string): Promise<string> {
    const root = await realpath(this.cwd);
    const target = cwd ? await realpath(resolve(root, cwd)) : root;
    const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Pi model probe cwd escapes the trusted workspace");
    }
    if (!(await stat(target)).isDirectory())
      throw new Error("Pi model probe cwd must be a directory");
    return target;
  }

  private async probe<T>(
    operation: (peer: JsonPeer, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<T> {
    const probeSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    probeSignal.throwIfAborted();
    const probeCwd = await this.probeCwd(cwd).catch((cause: unknown) => {
      throw new PiModelRuntimeError("PI_WORKSPACE_UNAVAILABLE", { cause });
    });
    probeSignal.throwIfAborted();
    const child = spawn(this.command, localPiRpcArguments(), {
      cwd: probeCwd,
      env: sanitizedLocalPiEnvironment({ [LOCAL_PI_MODEL_PROBE_ENV]: "1" }),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolveExit());
    });
    void exited.catch(() => undefined);
    if (!child.pid) {
      try {
        await exited;
      } catch (error) {
        throw new PiModelRuntimeError("PI_START_FAILED", { cause: error });
      }
      throw new PiModelRuntimeError("PI_START_FAILED");
    }
    child.stderr.resume();
    let peer: JsonPeer | undefined;
    try {
      peer = new JsonPeer(
        localPiChildPort(child),
        async () => {
          throw new Error("Stock Pi RPC sent an unexpected reverse request");
        },
        (message) => {
          const id = publicIdentity(message.id, 500);
          const method = publicIdentity(message.method, 100);
          if (
            message.type === "extension_ui_request" &&
            id &&
            method &&
            BLOCKING_PI_UI_METHODS.has(method)
          ) {
            queueMicrotask(() => {
              void peer
                ?.send({ type: "extension_ui_response", id, cancelled: true })
                .catch(() => undefined);
            });
          }
        },
        true,
      );
      void peer.finished.catch(() => undefined);
      return await operation(peer, probeSignal);
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      if (probeSignal.aborted) {
        throw new PiModelRuntimeError("PI_DISCOVERY_TIMEOUT", { cause });
      }
      if (cause instanceof PiModelRuntimeError) throw cause;
      if (cause instanceof Error && cause.message === "Managed RPC disconnected") {
        throw new PiModelRuntimeError("PI_DISCONNECTED", { cause });
      }
      if (
        cause instanceof SyntaxError ||
        (cause instanceof Error &&
          (cause.message.startsWith("Managed RPC") || cause.message === "Pi command rejected"))
      ) {
        throw new PiModelRuntimeError("PI_PROTOCOL_FAILED", { cause });
      }
      throw cause;
    } finally {
      await peer?.close().catch(() => undefined);
      await stopProbe(child, exited);
    }
  }
}

async function stopProbe(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killOwnedProcessTree(child, "SIGTERM");
  await Promise.race([
    exited.catch(() => undefined),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 750)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    killOwnedProcessTree(child, "SIGKILL");
    await Promise.race([
      exited.catch(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 750)),
    ]);
  }
}
