import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  AgentToolExecutionResult,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import {
  type ModelSelection,
  type ModelSelectionStatus,
  ModelSelectionStatusSchema,
  type QueueControlCommand,
  type QueueControlResult,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { PI_RUNTIME_VERSION } from "@rakazo/pi-kit";
import { isToolPauseResult } from "./approval-effect.js";
import {
  boundedExecutionEvidence,
  fabricNestedCallEvidence,
  nestedFabricExecutionEvents,
} from "./pi-execution-evidence.js";
import { type JsonRecord, type PrivateDuplex, record } from "./pi-rpc-protocol.js";
import { AsyncChannel, JsonPeer } from "./pi-rpc-transport.js";
import {
  describeToolActivity,
  normalizeAgentToolNames,
  parametersFor,
  toPiImages,
} from "./pi-runtime.js";
import { prepareManagedToolArguments } from "./pi-tool-arguments.js";
import { MANAGED_RESERVED_TOOL_NAMES } from "./pi-tool-names.js";

import { RAKAZO_SKILL_PATH } from "./rakazo-guidance.js";

const MINIMUM_PI_VERSION = PI_RUNTIME_VERSION.split(".").map(Number);
const BRIDGE_ENV = "RAKAZO_LOCAL_PI_BRIDGE_ENDPOINT";
const MAX_BRIDGE_BODY_BYTES = 16 * 1024 * 1024;
const LOCAL_EXTENSION = fileURLToPath(new URL("./pi-local-extension.ts", import.meta.url));
export const LOCAL_PI_MODEL_PROBE_ENV = "RAKAZO_PI_MODEL_PROBE";
export const BLOCKING_PI_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export type LocalPiRuntimeOptions = { command?: string; cwd: string; sessionDir: string };

export function localPiRpcArguments(sessionFile?: string): string[] {
  return [
    "--mode",
    "rpc",
    ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]),
    "--extension",
    LOCAL_EXTENSION,
    "--skill",
    RAKAZO_SKILL_PATH,
  ];
}
const INHERITED_SESSION_ENV = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

type LocalOutboxMessage = {
  id: string;
  messageId: string;
  text: string;
  historyText?: string;
  participantId?: string;
  placement?: { cwd: string; worktreeId?: string };
  images?: Array<{ name: string; mimeType: string; data: string }>;
};

type LocalCheckpoint = {
  version: 1;
  runtime: "pi-local";
  botHash: string;
  threadHash: string;
  cwdHash: string;
  generation: string;
  sessionId: string;
  pendingSourceMessageId?: string;
  lastCompletedSourceMessageId?: string;
  boundaryState?: unknown;
  modelSelection?: ModelSelectionStatus;
  outbox?: LocalOutboxMessage[];
};

type PreparedSession = {
  checkpoint: LocalCheckpoint;
  file: string;
  lock: string;
  isNew: boolean;
  recordChild(pid: number): Promise<void>;
  release(): Promise<void>;
};

type ProductTool = {
  handle: string;
  exposedName: string;
  tool: ConnectorTool;
  parameters: ReturnType<typeof parametersFor>;
};

type StreamItem = { kind: "rpc"; value: JsonRecord } | { kind: "event"; value: AgentRuntimeEvent };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function piModelSelection(value: unknown): ModelSelection | null {
  const state = object(value);
  const model = object(state?.model);
  const provider = stringValue(model?.provider);
  const modelId = stringValue(model?.id);
  if (!provider || !modelId) return null;
  const thinking = ThinkingLevelSchema.safeParse(state?.thinkingLevel);
  return {
    provider,
    modelId,
    thinkingLevel: thinking.success ? thinking.data : null,
  };
}

function storeMessage(message: AgentSteeringMessage): LocalOutboxMessage {
  return {
    id: message.id,
    messageId: message.messageId,
    text: message.text,
    ...(message.historyText ? { historyText: message.historyText } : {}),
    ...(message.participantId ? { participantId: message.participantId } : {}),
    ...(message.placement ? { placement: message.placement } : {}),
    ...(message.images?.length
      ? {
          images: message.images.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          })),
        }
      : {}),
  };
}

function restoreMessage(message: LocalOutboxMessage): AgentSteeringMessage {
  return {
    id: message.id,
    messageId: message.messageId,
    text: message.text,
    ...(message.historyText ? { historyText: message.historyText } : {}),
    ...(message.participantId ? { participantId: message.participantId } : {}),
    ...(message.placement ? { placement: message.placement } : {}),
    ...(message.images?.length
      ? {
          images: message.images.map((image) => ({
            name: image.name,
            mimeType: image.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
            data: Buffer.from(image.data, "base64"),
          })),
        }
      : {}),
  };
}

function deliveryMarker(id: string): string {
  return `<rakazo-queue-delivery id="${hash(id)}" />`;
}

export function sanitizedLocalPiEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.RAKAZO_DEV_PI_PATH !== undefined) env.PATH = env.RAKAZO_DEV_PI_PATH;
  delete env.RAKAZO_DEV_PI_PATH;
  for (const name of INHERITED_SESSION_ENV) delete env[name];
  delete env[BRIDGE_ENV];
  return { ...env, ...extra };
}

async function resolveLocalPlacement(value: string | undefined, root: string): Promise<string> {
  const requested = resolve(root, value ?? ".");
  const contained = (path: string) => {
    const within = relative(root, path);
    return (
      within !== ".." &&
      !within.startsWith("../") &&
      !within.startsWith("..\\") &&
      !isAbsolute(within)
    );
  };
  if (!contained(requested))
    throw new Error("Local Pi placement must remain within its authoritative constructor cwd");
  const canonical = await assertDirectory(requested, "Local Pi placement");
  if (!contained(canonical))
    throw new Error("Local Pi placement must remain within its authoritative constructor cwd");
  return canonical;
}

async function assertDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function versionAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    if ((version[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

async function verifyPiVersion(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(command, ["--version"], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length < 4096) stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  let timer: NodeJS.Timeout | undefined;
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Pi CLI version check timed out")), 10_000);
      }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.race([
      exited.catch(() => ({ code: null, signal: null })),
      new Promise((resolveWait) => setTimeout(resolveWait, 500)),
    ]);
    if (error instanceof Error && error.message === "Pi CLI version check timed out") throw error;
    throw new Error(`Unable to start Pi CLI command ${JSON.stringify(command)}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result.code !== 0)
    throw new Error(
      `Pi CLI version check failed (exit ${result.code ?? result.signal ?? "unknown"})`,
    );
  const match = stdout.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) throw new Error("Pi CLI returned an unrecognized version");
  const version = match.slice(1, 4).map(Number);
  if (!versionAtLeast(version, MINIMUM_PI_VERSION))
    throw new Error(
      `Pi CLI ${version.join(".")} is incompatible; version ${PI_RUNTIME_VERSION} or newer is required`,
    );
}

function parseCheckpoint(
  value: unknown,
  expected: Pick<LocalCheckpoint, "botHash" | "threadHash" | "cwdHash">,
): LocalCheckpoint | undefined {
  const candidate = object(value);
  if (
    candidate?.version !== 1 ||
    candidate.runtime !== "pi-local" ||
    candidate.botHash !== expected.botHash ||
    candidate.threadHash !== expected.threadHash ||
    candidate.cwdHash !== expected.cwdHash ||
    typeof candidate.generation !== "string" ||
    !/^[a-f0-9-]{16,64}$/.test(candidate.generation) ||
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId
  )
    return undefined;
  const outbox = Array.isArray(candidate.outbox)
    ? candidate.outbox.filter(
        (item): item is LocalOutboxMessage =>
          typeof object(item)?.id === "string" &&
          typeof object(item)?.messageId === "string" &&
          typeof object(item)?.text === "string",
      )
    : [];
  const modelSelection = ModelSelectionStatusSchema.safeParse(candidate.modelSelection);
  return {
    ...(candidate as LocalCheckpoint),
    outbox,
    modelSelection: modelSelection.success ? modelSelection.data : undefined,
  };
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function readSessionHeader(path: string): Promise<Record<string, unknown> | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) return undefined;
    return object(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function prepareSession(
  sessionDir: string,
  cwd: string,
  request: AgentRunRequest,
  root?: string,
): Promise<PreparedSession> {
  const identity = {
    botHash: hash(request.botId),
    threadHash: hash(request.threadId),
    cwdHash: hash(cwd),
  };
  const directory = join(sessionDir, `bot-${identity.botHash}`, `thread-${identity.threadHash}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rawRestore = object(request.session?.restore);
  if (root && rawRestore?.runtime === "pi-local" && rawRestore.cwdHash !== identity.cwdHash) {
    const previous = parseCheckpoint(rawRestore, {
      ...identity,
      cwdHash: String(rawRestore.cwdHash),
    });
    if (!previous || !/^[a-f0-9]{24}$/.test(previous.cwdHash))
      throw new Error("Local Pi checkpoint ownership does not match this bot or thread");
    const canonicalDirectory = join(
      await realpath(sessionDir),
      `bot-${identity.botHash}`,
      `thread-${identity.threadHash}`,
    );
    if ((await realpath(directory)) !== canonicalDirectory)
      throw new Error("Local Pi checkpoint directory failed its ownership fence");
    const oldFile = join(directory, `${previous.generation}.jsonl`);
    const oldOwner = join(directory, `${previous.generation}.owner.json`);
    for (const path of [oldFile, oldOwner]) {
      if ((await realpath(path)) !== join(canonicalDirectory, path.slice(directory.length + 1)))
        throw new Error("Local Pi checkpoint symlink failed its ownership fence");
      if ((await stat(path)).nlink !== 1)
        throw new Error("Local Pi checkpoint aliases failed its ownership fence");
    }
    if (
      rawRestore.outbox !== undefined &&
      (!Array.isArray(rawRestore.outbox) || previous.outbox?.length !== rawRestore.outbox.length)
    )
      throw new Error("Local Pi checkpoint has an invalid pending outbox");
    const oldHeader = await readSessionHeader(oldFile);
    const oldCwd = stringValue(oldHeader?.cwd);
    if (
      !oldCwd ||
      hash(oldCwd) !== previous.cwdHash ||
      (await resolveLocalPlacement(oldCwd, root)) !== oldCwd ||
      (await resolveLocalPlacement(cwd, root)) !== cwd ||
      (await assertDirectory(root, "Local Pi root")) !== root ||
      (await assertDirectory(oldCwd, "Local Pi previous cwd")) !== oldCwd ||
      (await assertDirectory(cwd, "Local Pi cwd")) !== cwd
    )
      throw new Error(
        "Local Pi checkpoint ownership cwd is outside its canonical constructor root",
      );

    const oldLock = join(directory, `${previous.generation}.lock`);
    const retirement = await readJson(oldLock);
    if (retirement?.retired === true) {
      const successor = parseCheckpoint(retirement.successorCheckpoint, identity);
      const owner = await readJson(oldOwner);
      if (
        !successor ||
        successor.generation === previous.generation ||
        retirement.version !== 1 ||
        typeof retirement.token !== "string" ||
        retirement.successorGeneration !== successor.generation ||
        owner?.sessionId !== previous.sessionId ||
        owner.botHash !== identity.botHash ||
        owner.threadHash !== identity.threadHash ||
        owner.cwdHash !== previous.cwdHash ||
        oldHeader?.type !== "session" ||
        oldHeader.id !== previous.sessionId
      )
        throw new Error("Local Pi retired ownership lock has an invalid successor");
      for (const name of [
        `${previous.generation}.lock`,
        `${successor.generation}.jsonl`,
        `${successor.generation}.owner.json`,
      ]) {
        const path = join(directory, name);
        if (
          (await realpath(path)) !== join(canonicalDirectory, name) ||
          (await stat(path)).nlink !== 1
        )
          throw new Error("Local Pi successor failed its ownership fence");
      }
      const nextOwner = await readJson(join(directory, `${successor.generation}.owner.json`));
      if (
        nextOwner?.predecessorGeneration !== previous.generation ||
        nextOwner.predecessorToken !== retirement.token
      )
        throw new Error("Local Pi retired ownership lock has an unrelated successor");
      const rawNext = object(retirement.successorCheckpoint);
      if (
        rawNext?.outbox !== undefined &&
        (!Array.isArray(rawNext.outbox) || successor.outbox?.length !== rawNext.outbox.length)
      )
        throw new Error("Local Pi successor has an invalid pending outbox");
      return prepareSession(sessionDir, cwd, {
        ...request,
        session: { ...request.session!, restore: successor },
      });
    }

    // Reuse the exact-cwd fence and acquire exclusive ownership before reading history.
    const source = await prepareSession(sessionDir, oldCwd, request);
    const sourceToken = (await readJson(source.lock))?.token;
    let target: PreparedSession | undefined;
    let retired = false;
    try {
      for (const path of [directory, oldFile, oldOwner]) {
        const expected =
          path === directory
            ? canonicalDirectory
            : join(canonicalDirectory, path.slice(directory.length + 1));
        if ((await realpath(path)) !== expected)
          throw new Error("Local Pi checkpoint symlink changed before history cloning");
      }
      const bytes = await readFile(oldFile);
      const contents = bytes.toString("utf8");
      if (!Buffer.from(contents, "utf8").equals(bytes))
        throw new Error("Local Pi checkpoint contains invalid UTF-8 history");
      const newline = contents.indexOf("\n");
      const header = object(JSON.parse(contents.slice(0, newline)));
      const owner = await readJson(oldOwner);
      if (
        header?.type !== "session" ||
        header.id !== previous.sessionId ||
        header.cwd !== oldCwd ||
        owner?.sessionId !== previous.sessionId ||
        owner.botHash !== identity.botHash ||
        owner.threadHash !== identity.threadHash ||
        owner.cwdHash !== previous.cwdHash ||
        !contents.endsWith("\n")
      )
        throw new Error("Local Pi checkpoint changed before history cloning");
      const entries = contents.slice(newline + 1);
      for (const line of entries.split("\n").slice(0, -1)) {
        const entry = object(JSON.parse(line));
        if (!entry || typeof entry.type !== "string" || entry.type === "session")
          throw new Error("Local Pi checkpoint has ambiguous native history");
      }
      target = await prepareSession(sessionDir, cwd, {
        ...request,
        session: { ...request.session!, restore: undefined },
      });
      await writeFile(
        target.file,
        `${JSON.stringify({ ...header, id: target.checkpoint.sessionId, cwd })}\n${entries}`,
        { mode: 0o600 },
      );
      target.checkpoint = {
        ...previous,
        ...target.checkpoint,
        outbox: previous.outbox?.map((message) => ({
          ...message,
          placement: message.placement ?? { cwd: relative(root, oldCwd) || "." },
        })),
      };
      // Preserve continuation state, but never import initial product history a second time.
      target.isNew = false;
      if (!sourceToken || (await readJson(source.lock))?.token !== sourceToken)
        throw new Error("Local Pi ownership lock changed during history cloning");
      // Keep the old lock as a retirement fence: stale checkpoints must not fork history.
      const nextOwnerPath = target.file.replace(/\.jsonl$/, ".owner.json");
      await writeFile(
        nextOwnerPath,
        `${JSON.stringify({
          ...(await readJson(nextOwnerPath)),
          predecessorGeneration: previous.generation,
          predecessorToken: sourceToken,
        })}\n`,
        { mode: 0o600 },
      );
      const retirementPath = `${source.lock}.${sourceToken}.retired`;
      await writeFile(
        retirementPath,
        `${JSON.stringify({
          version: 1,
          token: sourceToken,
          retired: true,
          successorGeneration: target.checkpoint.generation,
          successorCheckpoint: target.checkpoint,
          runIdHash: hash(request.runId),
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      // Atomic publication leaves either the ownership fence or its complete successor record.
      await rename(retirementPath, source.lock);
      retired = true;
      return target;
    } finally {
      if (!retired) {
        await target?.release();
        await source.release();
      }
    }
  }
  const restored = parseCheckpoint(request.session?.restore, identity);
  if (rawRestore?.runtime === "pi-local" && !restored)
    throw new Error("Local Pi checkpoint ownership does not match this bot, thread, or cwd");

  const verify = async (checkpoint: LocalCheckpoint) => {
    const file = join(directory, `${checkpoint.generation}.jsonl`);
    const owner = await readJson(join(directory, `${checkpoint.generation}.owner.json`));
    const header = await readSessionHeader(file);
    return owner?.sessionId === checkpoint.sessionId &&
      owner.botHash === identity.botHash &&
      owner.threadHash === identity.threadHash &&
      owner.cwdHash === identity.cwdHash &&
      header?.type === "session" &&
      header.id === checkpoint.sessionId &&
      header.cwd === cwd
      ? file
      : undefined;
  };

  let checkpoint = restored;
  let file = checkpoint ? await verify(checkpoint).catch(() => undefined) : undefined;
  if (checkpoint && !file)
    throw new Error("Local Pi checkpoint session is missing or failed its ownership fence");
  let isNew = false;
  if (!checkpoint) {
    isNew = true;
    for (;;) {
      const generation = randomUUID();
      const sessionId = randomUUID();
      const candidate = join(directory, `${generation}.jsonl`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(candidate, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        await handle.writeFile(
          `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`,
        );
        await handle.close();
        handle = undefined;
        checkpoint = { version: 1, runtime: "pi-local", ...identity, generation, sessionId };
        file = candidate;
        await writeFile(
          join(directory, `${generation}.owner.json`),
          `${JSON.stringify({ version: 1, ...identity, sessionId })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        break;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(candidate, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  }

  if (!file) throw new Error("Local Pi session path was not prepared");
  const lock = join(directory, `${checkpoint.generation}.lock`);
  const lockToken = randomUUID();
  const lockState = (childPid?: number) => ({
    version: 1,
    token: lockToken,
    parentPid: process.pid,
    ...(childPid ? { childPid } : {}),
    runIdHash: hash(request.runId),
  });
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lock, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify(lockState())}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "A local Pi ownership lock already exists; refusing takeover. If the app crashed, verify its Pi process is gone before removing the stale lock.",
      );
    throw error;
  } finally {
    await lockHandle?.close();
  }
  const stillOwned = async () => (await readJson(lock))?.token === lockToken;
  return {
    checkpoint,
    file,
    lock,
    isNew,
    async recordChild(pid) {
      if (!(await stillOwned())) throw new Error("Local Pi ownership lock changed before spawn");
      await writeFile(lock, `${JSON.stringify(lockState(pid))}\n`, { mode: 0o600 });
    },
    async release() {
      if (await stillOwned()) await rm(lock, { force: true });
    },
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const structured = object(value) as
    | (Partial<AgentToolExecutionResult> & { error?: unknown })
    | undefined;
  if (structured?.kind === "agent_tool_result" || Array.isArray(structured?.content)) {
    return {
      content: structured.content,
      ...(structured.details === undefined ? {} : { details: structured.details }),
      ...(structured.isError === undefined ? {} : { isError: structured.isError }),
      ...(structured.terminate === undefined ? {} : { terminate: structured.terminate }),
    };
  }
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value ?? null),
      },
    ],
    details: value,
  };
}

class LocalToolBridge {
  private server?: Server;
  private endpoint?: string;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolveReady, rejectReady) => {
    this.resolveReady = resolveReady;
    this.rejectReady = rejectReady;
  });
  private readonly token = randomUUID();
  private readonly tools = new Map<string, ProductTool>();
  private readonly exposed = new Map<string, ProductTool>();
  private readonly usedCalls = new Set<string>();
  readonly pausedCalls = new Set<string>();

  constructor(
    private readonly request: AgentRunRequest,
    private readonly signal: AbortSignal,
    private readonly emit: (event: AgentRuntimeEvent) => void,
    private readonly pause: (fatal?: Error) => void,
  ) {
    const names = normalizeAgentToolNames(request.tools);
    request.tools.forEach((tool, index) => {
      if (tool.name === "run_subagent" || MANAGED_RESERVED_TOOL_NAMES.has(tool.name)) return;
      const item = {
        handle: randomUUID(),
        exposedName: names[index]!,
        tool,
        parameters: parametersFor(tool),
      };
      this.tools.set(item.handle, item);
      this.exposed.set(item.exposedName, item);
    });
    void this.ready.catch(() => undefined);
  }

  originalName(exposedName: string): string {
    return this.exposed.get(exposedName)?.tool.name ?? exposedName;
  }

  isProductTool(exposedName: string): boolean {
    return this.exposed.has(exposedName);
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.respond(response, 500, {
          error: error instanceof Error ? error.message : "Bridge failed",
        });
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Local Pi bridge failed to bind");
    this.endpoint = `http://127.0.0.1:${address.port}/${this.token}`;
    return this.endpoint;
  }

  waitUntilReady(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return Promise.race([
      this.ready,
      new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(signal.reason ?? new Error("Local Pi extension readiness aborted"));
        signal.addEventListener("abort", abort, { once: true });
        const cleanup = () => signal.removeEventListener("abort", abort);
        void this.ready.then(cleanup, cleanup);
      }),
    ]);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || !url.pathname.startsWith(`/${this.token}/`)) {
      this.respond(response, 404, { error: "Not found" });
      return;
    }
    const action = url.pathname.slice(this.token.length + 2);
    const input = await this.readBody(request);
    if (action === "bootstrap") {
      this.respond(response, 200, {
        instructions: this.request.instructions,
        continuation: this.request.resumeFromCheckpoint,
        tools: [...this.tools.values()].map((item) => ({
          handle: item.handle,
          exposedName: item.exposedName,
          name: item.tool.name,
          description: item.tool.description,
          parameters: item.parameters,
        })),
      });
      return;
    }
    if (action === "ready") {
      this.resolveReady();
      this.respond(response, 200, { ready: true });
      return;
    }
    if (action === "collision") {
      const error = new Error(
        `Local Pi product tool conflicts with an installed tool: ${String(input.name)}`,
      );
      this.rejectReady(error);
      this.respond(response, 409, { error: error.message });
      return;
    }
    if (action === "lease") {
      try {
        const active = await this.request.assertActive?.({ effects: input.effects === true });
        this.signal.throwIfAborted();
        if (active === "pause") {
          this.pause();
          this.respond(response, 200, { active: false, pause: true });
        } else this.respond(response, 200, { active: true });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Local Pi lease check failed");
        this.pause(failure);
        this.respond(response, 409, { error: "Run lease is no longer active" });
      }
      return;
    }
    if (action === "tool") {
      this.respond(response, 200, await this.execute(input));
      return;
    }
    this.respond(response, 404, { error: "Unsupported bridge operation" });
  }

  private async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    const handle = stringValue(input.handle);
    const toolCallId = stringValue(input.toolCallId);
    const item = handle ? this.tools.get(handle) : undefined;
    if (!item || !toolCallId) throw new Error("Unknown local Pi product tool");
    if (this.usedCalls.has(toolCallId))
      throw new Error("Local Pi tool invocation cannot be replayed");
    this.usedCalls.add(toolCallId);
    const active = await this.checkActive(true);
    if (active === "pause") {
      this.pausedCalls.add(toolCallId);
      this.pause();
      return toolResult({
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Paused" }],
        details: { queue: "paused" },
        terminate: true,
      });
    }
    this.signal.throwIfAborted();
    const args = validateToolArguments(
      { name: item.tool.name, description: item.tool.description, parameters: item.parameters },
      {
        type: "toolCall",
        id: toolCallId,
        name: item.tool.name,
        arguments: prepareManagedToolArguments(item.tool.name, object(input.args) ?? {}),
      },
    ) as Record<string, unknown>;
    const executionId = `${this.request.runId}:${toolCallId}`;
    let value: unknown;
    if (item.tool.name === "ask_user") {
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      if (options.length < 2 || options.length > 4 || new Set(options).size !== options.length)
        throw new Error("Invalid choice options");
      this.emit({
        type: "ask",
        text: String(args.question),
        actions: options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
      });
      value = {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Waiting for the user's choice." }],
        details: { approval: "paused" },
        terminate: true,
      };
    } else if (item.tool.name === "request_takeover") {
      this.emit({ type: "takeover", reason: String(args.reason) });
      value = {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Takeover requested." }],
        details: { approval: "paused" },
        terminate: true,
      };
    } else {
      if (!this.request.executeTool)
        throw new Error("Product tool unavailable without an authorized executor");
      value = await this.request.executeTool(
        item.tool.name,
        args,
        executionId,
        item.tool.route,
        this.signal,
      );
    }
    const after = await this.checkActive(false);
    this.signal.throwIfAborted();
    if (after === "pause" || isToolPauseResult(value) || object(value)?.terminate === true) {
      this.pausedCalls.add(toolCallId);
      this.pause();
    }
    return toolResult(value);
  }

  private async checkActive(effects: boolean): Promise<undefined | "pause"> {
    try {
      const result = await this.request.assertActive?.({ effects });
      return result === "pause" ? "pause" : undefined;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Local Pi lease check failed");
      this.pause(failure);
      throw failure;
    }
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_BRIDGE_BODY_BYTES) throw new Error("Local Pi bridge request exceeds limit");
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  private respond(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }
}

export function killOwnedProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  if (signal === "SIGKILL") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
  } else child.kill(signal);
}

export function localPiChildPort(child: ChildProcessWithoutNullStreams): PrivateDuplex {
  return {
    incoming: child.stdout as AsyncIterable<Uint8Array>,
    write: (frame) =>
      new Promise<void>((resolveWrite, reject) => {
        child.stdin.write(frame, (error?: Error | null) =>
          error ? reject(error) : resolveWrite(),
        );
      }),
    close: () =>
      new Promise<void>((resolveClose) => {
        if (child.stdin.destroyed) resolveClose();
        else child.stdin.end(() => resolveClose());
      }),
  };
}

function combineMessages(messages: AgentSteeringMessage[]): {
  text: string;
  images: ReturnType<typeof toPiImages>;
} {
  return {
    text: messages
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n"),
    images: messages.flatMap((message) => toPiImages(message.images)),
  };
}

function importedHistory(request: AgentRunRequest): string {
  if (!request.history.length) return "";
  return request.history
    .map(
      (message) =>
        `${message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System"}: ${message.content}`,
    )
    .join("\n\n");
}

export class LocalPiRuntime implements AgentRuntime {
  private readonly running = new Map<
    string,
    { controller: AbortController; settled: Promise<void> }
  >();
  private readonly command: string;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private piVersionVerified = false;

  constructor(options: LocalPiRuntimeOptions) {
    if (!options.cwd || !isAbsolute(options.cwd)) throw new Error("Local Pi cwd must be absolute");
    if (!options.sessionDir || !isAbsolute(options.sessionDir))
      throw new Error("Local Pi sessionDir must be absolute");
    if (options.command !== undefined && !options.command.trim())
      throw new Error("Local Pi command must not be empty");
    this.command = options.command?.trim() || "pi";
    this.cwd = resolve(options.cwd);
    this.sessionDir = resolve(options.sessionDir);
  }

  describe() {
    return {
      id: "pi-local",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        scripted: false,
        memory: false,
      },
    };
  }

  async abort(runId: string): Promise<void> {
    const active = this.running.get(runId);
    active?.controller.abort(new Error("Local Pi run aborted"));
    await active?.settled;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const events = this.events(request, controller, context);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        controller.abort(new Error("Local Pi consumer closed"));
        return events.return(undefined);
      },
      throw: (error) => {
        controller.abort(error);
        return events.throw(error);
      },
    };
  }

  private async *events(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent> {
    if (this.running.has(request.runId)) throw new Error("A local Pi run is already active");
    let settle!: () => void;
    const settled = new Promise<void>((resolveSettled) => {
      settle = resolveSettled;
    });
    const active = { controller, settled };
    this.running.set(request.runId, active);
    try {
      const signal = context?.signal
        ? AbortSignal.any([controller.signal, context.signal])
        : controller.signal;
      yield* this.execute(request, signal);
      signal.throwIfAborted();
    } finally {
      settle();
      if (this.running.get(request.runId) === active) this.running.delete(request.runId);
    }
  }

  private async *execute(
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentRuntimeEvent> {
    const root = await assertDirectory(this.cwd, "Local Pi cwd");
    const cwd = await resolveLocalPlacement(request.placement?.cwd, root);
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const sessionDir = await assertDirectory(this.sessionDir, "Local Pi sessionDir");
    const initiallyActive = await request.assertActive?.({ effects: false });
    signal.throwIfAborted();
    if (initiallyActive === "pause") {
      yield { type: "runtime_activity", activity: "queue", status: "paused" };
      yield { type: "done" };
      return;
    }
    if (request.authorizeSubagentPlacement && request.placement) {
      const placement = { ...request.placement, cwd: relative(root, cwd) || "." };
      const authorized = await request.authorizeSubagentPlacement(placement, request.runId);
      if ((await resolveLocalPlacement(authorized.placement.cwd, root)) !== cwd)
        throw new Error("Local Pi placement authorization changed the requested cwd");
      request.placement = { ...authorized.placement, cwd: placement.cwd };
      request.executeTool = authorized.executeTool;
    } else if (cwd !== root) {
      throw new Error(
        "Local Pi placement authorization is required for a workspace below the constructor root",
      );
    }
    signal.throwIfAborted();
    const env = sanitizedLocalPiEnvironment();
    if (!this.piVersionVerified) {
      await verifyPiVersion(this.command, cwd, env);
      this.piVersionVerified = true;
    }
    signal.throwIfAborted();

    const session = await prepareSession(sessionDir, cwd, request, root);
    const stream = new AsyncChannel<StreamItem>();
    let peer: JsonPeer | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let gracefulPaused = false;
    let fatalError: Error | undefined;
    let currentBoundary: "before_model" | "settled" | "idle" | "paused" = "idle";
    let pendingCompact = false;
    let boundaryState = session.checkpoint.boundaryState;
    session.checkpoint.outbox ??= [];
    const seenSteering = new Set(session.checkpoint.outbox.map((message) => message.id));
    const activeTools = new Map<string, { name: string; args: Record<string, unknown> }>();
    let text = "";
    let terminalFailure: Error | undefined;
    const requestPiAbort = (fatal?: Error) => {
      if (fatal) fatalError = fatal;
      else gracefulPaused = true;
      if (peer) void peer.request("abort", {}, AbortSignal.timeout(2_000)).catch(() => undefined);
    };
    const bridge = new LocalToolBridge(
      request,
      signal,
      (event) => stream.push({ kind: "event", value: event }),
      requestPiAbort,
    );

    const saveCheckpoint = async (changes: Partial<LocalCheckpoint> = {}) => {
      session.checkpoint = { ...session.checkpoint, ...changes, boundaryState };
      if (!request.session) return;
      signal.throwIfAborted();
      const active = await request.assertActive?.({ effects: false, checkpoint: true });
      if (active === "pause") gracefulPaused = true;
      await request.session.save(session.checkpoint);
    };

    const authorizeMessage = async (message: AgentSteeringMessage) => {
      if (!message.placement) return;
      if ((await resolveLocalPlacement(message.placement.cwd, root)) !== cwd)
        throw new Error("Changing local Pi cwd requires a new run");
      if (!request.authorizeSubagentPlacement)
        throw new Error("Queued local Pi placement authorization is unavailable");
      const authorized = await request.authorizeSubagentPlacement(
        { ...message.placement, cwd: relative(root, cwd) || "." },
        request.runId,
      );
      if ((await resolveLocalPlacement(authorized.placement.cwd, root)) !== cwd)
        throw new Error("Local Pi placement authorization changed the active cwd");
      request.placement = { ...authorized.placement, cwd: relative(root, cwd) || "." };
      request.executeTool = authorized.executeTool;
    };

    const compact = async (instructions?: string): Promise<QueueControlResult> => {
      if (currentBoundary === "before_model")
        return { outcome: "rejected", error: "Local Pi cannot compact during a model turn" };
      try {
        const value = object(
          await peer!.request(
            "compact",
            instructions ? { customInstructions: instructions } : {},
            signal,
          ),
        );
        if (value?.aborted === true || value?.error !== undefined)
          return { outcome: "rejected", error: "Pi compaction failed or was aborted" };
        return { outcome: "completed" };
      } catch {
        return { outcome: "uncertain", error: "Pi compaction completion was not confirmed" };
      }
    };

    const runBoundary = async (
      name: "before_model" | "settled" | "idle" | "paused",
    ): Promise<AgentSteeringMessage[]> => {
      currentBoundary = name;
      if (name !== "paused") {
        const state = await request.assertActive?.({ effects: false });
        if (state === "pause") gracefulPaused = true;
        signal.throwIfAborted();
      }
      const messages: AgentSteeringMessage[] = [];
      const deliver = async (message: AgentSteeringMessage) => {
        await authorizeMessage(message);
        if (!seenSteering.has(message.id)) {
          if (!request.session)
            throw new Error("Local Pi queue delivery requires a durable runtime session");
          seenSteering.add(message.id);
          messages.push(message);
          session.checkpoint.outbox = [...(session.checkpoint.outbox ?? []), storeMessage(message)];
          await saveCheckpoint();
        }
      };
      const result = await request.runtimeBoundary?.(name, {
        participantId: request.runId,
        deliver,
        command: async (
          command: QueueControlCommand,
          context: { id: string; signal: AbortSignal },
        ) => {
          context.signal.throwIfAborted();
          if (command.kind === "compact") {
            const participantId = "participantId" in command ? command.participantId : undefined;
            if (participantId && participantId !== request.runId)
              return { outcome: "rejected", error: "Local Pi does not own that participant" };
            return compact(command.instructions);
          }
          return {
            outcome: "rejected",
            error: "Local Pi cannot await installed Pi/Fabric participants",
          };
        },
        pause: async () => {
          gracefulPaused = true;
          requestPiAbort();
        },
      });
      if (result?.state !== undefined) boundaryState = result.state;
      if (result?.compact) pendingCompact = true;
      for (const message of result?.messages ?? []) await deliver(message);
      if (name === "before_model") {
        for (const message of (await request.claimSteering?.([...seenSteering])) ?? [])
          await deliver(message);
      }
      return messages;
    };

    const acknowledgeMessages = async (messages: AgentSteeringMessage[]) => {
      const accepted = new Set(messages.map((message) => message.id));
      session.checkpoint.outbox = (session.checkpoint.outbox ?? []).filter(
        (message) => !accepted.has(message.id),
      );
      await saveCheckpoint();
    };

    const sendPrompt = async (messages: AgentSteeringMessage[], primary?: string) => {
      const combined = combineMessages(messages);
      const pieces: string[] = [];
      if (primary) pieces.push(primary);
      for (const queued of messages) pieces.push(`${deliveryMarker(queued.id)}\n${queued.text}`);
      const message = `User request:\n${pieces.join("\n\nAdditional user context:\n")}`;
      await peer!.request(
        "prompt",
        {
          message,
          images: [...toPiImages(request.currentTurnImages), ...combined.images],
        },
        signal,
      );
      if (messages.length) await acknowledgeMessages(messages);
    };

    const sendSteering = async (messages: AgentSteeringMessage[]) => {
      for (const message of messages) {
        await peer!.request(
          "prompt",
          {
            message: `${deliveryMarker(message.id)}\nAdditional user context:\n${message.text}`,
            images: toPiImages(message.images),
            streamingBehavior: "steer",
          },
          signal,
        );
        await acknowledgeMessages([message]);
      }
    };

    const stopChild = async (cancelTree: boolean) => {
      if (!child) return;
      await Promise.race([
        peer?.close().catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 500)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
        const timer = setTimeout(() => killOwnedProcessTree(child!, "SIGTERM"), 750);
        await Promise.race([
          exited,
          new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_500)),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
          killOwnedProcessTree(child, "SIGKILL");
      }
      if (cancelTree) {
        killOwnedProcessTree(child, "SIGTERM");
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        killOwnedProcessTree(child, "SIGKILL");
      }
    };

    try {
      await saveCheckpoint();
      if (gracefulPaused) {
        yield { type: "runtime_activity", activity: "queue", status: "paused" };
        yield { type: "done" };
        return;
      }
      const endpoint = await bridge.start();
      const childEnv = sanitizedLocalPiEnvironment({ [BRIDGE_ENV]: endpoint });
      child = spawn(this.command, localPiRpcArguments(session.file), {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, childSignal) => {
            resolveExit({ code, signal: childSignal });
            stream.close(
              new Error(
                `Pi RPC exited before agent_settled (exit ${code ?? childSignal ?? "unknown"})`,
              ),
            );
          });
        },
      );
      void childExit.catch(() => undefined);
      if (!child.pid) {
        try {
          await childExit;
        } catch (error) {
          throw new Error("Pi RPC could not start", { cause: error });
        }
        throw new Error("Pi RPC did not expose an owned process id");
      }
      await session.recordChild(child.pid);
      child.stderr.resume();
      peer = new JsonPeer(
        localPiChildPort(child),
        async () => {
          throw new Error("Stock Pi RPC sent an unexpected reverse request");
        },
        (value) => {
          const method = stringValue(value.method);
          const id = stringValue(value.id);
          if (
            value.type === "extension_ui_request" &&
            id &&
            method &&
            BLOCKING_PI_UI_METHODS.has(method)
          ) {
            queueMicrotask(() => {
              void peer
                ?.send({ type: "extension_ui_response", id, cancelled: true })
                .catch(() => undefined);
            });
            return;
          }
          stream.push({ kind: "rpc", value });
        },
        true,
      );
      const abort = () =>
        requestPiAbort(signal.reason instanceof Error ? signal.reason : undefined);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const [, stateValue, messagesValue] = await Promise.all([
          bridge.waitUntilReady(startupSignal),
          peer.request("get_state", {}, startupSignal),
          peer.request("get_messages", {}, startupSignal),
        ]);
        const state = object(stateValue);
        if (
          resolve(String(state?.sessionFile ?? "")) !== resolve(session.file) ||
          state?.sessionId !== session.checkpoint.sessionId
        )
          throw new Error("Pi RPC opened a session outside the local runtime ownership fence");
        const persistedMessages = JSON.stringify(object(messagesValue)?.messages ?? []);
        const acceptedOutbox = (session.checkpoint.outbox ?? []).filter((message) =>
          persistedMessages.includes(deliveryMarker(message.id)),
        );
        if (acceptedOutbox.length) await acknowledgeMessages(acceptedOutbox.map(restoreMessage));
        const restoredOutbox = (session.checkpoint.outbox ?? []).map(restoreMessage);
        for (const message of restoredOutbox) await authorizeMessage(message);

        const configuredByPi =
          request.model.provider === "pi-local" && request.model.id === "default";
        const requested: ModelSelection | null = configuredByPi
          ? null
          : {
              provider: request.model.provider,
              modelId: request.model.id,
              thinkingLevel: request.model.thinkingLevel ?? null,
            };
        const previous = session.checkpoint.modelSelection?.effective ?? null;
        const pending: ModelSelectionStatus = {
          requested,
          effective: previous,
          status: "pending",
          error: null,
        };
        await saveCheckpoint({ modelSelection: pending });
        try {
          if (!configuredByPi) {
            const modelActive = await request.assertActive?.({ effects: false });
            if (modelActive === "pause") gracefulPaused = true;
            else
              await peer.request(
                "set_model",
                { provider: request.model.provider, modelId: request.model.id },
                signal,
              );
          }
          if (request.model.thinkingLevel && !gracefulPaused)
            await peer.request(
              "set_thinking_level",
              { level: request.model.thinkingLevel },
              signal,
            );
          if (!gracefulPaused) {
            const acknowledged = piModelSelection(await peer.request("get_state", {}, signal));
            if (
              !acknowledged ||
              (requested &&
                (acknowledged.provider !== requested.provider ||
                  acknowledged.modelId !== requested.modelId ||
                  (requested.thinkingLevel !== null &&
                    acknowledged.thinkingLevel !== requested.thinkingLevel)))
            )
              throw new Error("Pi did not acknowledge the requested model configuration");
            await saveCheckpoint({
              modelSelection: {
                ...pending,
                effective: acknowledged,
                status: "applied",
              },
            });
          }
        } catch (error) {
          await saveCheckpoint({
            modelSelection: {
              ...pending,
              status: "failed",
              error: "Model change was not acknowledged by Pi",
            },
          });
          throw error;
        }

        const initialMessages = [...restoredOutbox, ...(await runBoundary("idle"))].filter(
          (message, index, messages) =>
            messages.findIndex((candidate) => candidate.id === message.id) === index,
        );
        if (pendingCompact) {
          pendingCompact = false;
          const result = await compact();
          if (result.outcome !== "completed") throw new Error(result.error);
        }
        if (gracefulPaused) {
          await runBoundary("paused");
          await saveCheckpoint();
          yield { type: "runtime_activity", activity: "queue", status: "paused" };
          yield { type: "done" };
          return;
        }
        if (request.queueOnly && initialMessages.length === 0) {
          await saveCheckpoint();
          yield { type: "done" };
          return;
        }

        const sourceKey = request.sourceMessageId ?? request.runId;
        let primary = request.queueOnly ? undefined : request.prompt;
        if (session.isNew) {
          const history = importedHistory(request);
          if (history) primary = `${history}\n\nCurrent request:\n${primary ?? ""}`;
        }
        if (session.checkpoint.pendingSourceMessageId === sourceKey)
          primary = "Continue the interrupted request without repeating work already completed.";
        if (
          session.checkpoint.lastCompletedSourceMessageId === sourceKey &&
          !initialMessages.length
        ) {
          yield { type: "done" };
          return;
        }
        await saveCheckpoint({ pendingSourceMessageId: sourceKey });
        await sendPrompt(initialMessages, primary);

        let finished = false;
        for await (const item of stream) {
          if (item.kind === "event") {
            yield item.value;
            continue;
          }
          const event = item.value;
          const eventType = stringValue(event.type);
          if (eventType === "disconnected") {
            if (!finished) throw new Error("Pi RPC disconnected before agent_settled");
            continue;
          }
          if (eventType === "extension_ui_request") continue;
          if (eventType === "message_update") {
            const update = object(event.assistantMessageEvent);
            if (update?.type === "text_delta" && typeof update.delta === "string") {
              text += update.delta;
              yield { type: "text", text: update.delta };
            }
            continue;
          }
          if (eventType === "message_end") {
            const message = object(event.message);
            if (message?.role === "custom" && message.customType === "pi-fabric-agent-complete") {
              const details = object(message.details);
              const agentId = stringValue(details?.id);
              if (agentId)
                yield {
                  type: "subagent",
                  agentId,
                  name: stringValue(details?.name) ?? "helper",
                  task: stringValue(details?.task) ?? "",
                  status: details?.status === "failed" ? "failed" : "completed",
                  ...(stringValue(details?.text)
                    ? { result: stringValue(details?.text) }
                    : stringValue(details?.error)
                      ? { result: stringValue(details?.error) }
                      : {}),
                };
              continue;
            }
            if (message?.role === "assistant") {
              const usage = object(message.usage);
              yield {
                type: "usage",
                inputTokens: numberValue(usage?.input),
                outputTokens: numberValue(usage?.output),
                provider: stringValue(message.provider) ?? request.model.provider,
                model: stringValue(message.model) ?? request.model.id,
              };
              const stopReason = stringValue(message.stopReason);
              if (stopReason === "error" || stopReason === "aborted") {
                const providerError =
                  stringValue(message.errorMessage) ?? stringValue(object(message.error)?.message);
                terminalFailure = new Error(
                  providerError ||
                    (stopReason === "aborted"
                      ? "Pi provider response was aborted"
                      : "Pi provider response failed"),
                );
              } else terminalFailure = undefined;
            }
            continue;
          }
          if (eventType === "turn_start") {
            const steering = await runBoundary("before_model");
            if (steering.length) await sendSteering(steering);
            continue;
          }
          if (eventType === "tool_execution_start") {
            const callId = stringValue(event.toolCallId);
            const exposedName = stringValue(event.toolName);
            if (!callId || !exposedName) continue;
            const name = bridge.originalName(exposedName);
            const args = object(event.args) ?? {};
            activeTools.set(callId, { name, args });
            yield { type: "progress", text: describeToolActivity(name, args), activity: true };
            yield { type: "tool", name, args, executionId: `${request.runId}:${callId}` };
            const evidence = boundedExecutionEvidence({
              input: args,
              ...(typeof args.code === "string" ? { code: args.code } : {}),
              ...(args.display !== undefined ? { display: args.display } : {}),
            });
            yield {
              type: "execution",
              executionId: `${request.runId}:${callId}`,
              name,
              participantId: request.runId,
              status: "started",
              ...evidence.value,
              ...(evidence.truncated ? { truncated: true } : {}),
            };
            continue;
          }
          if (eventType === "tool_execution_update" || eventType === "tool_execution_end") {
            const callId = stringValue(event.toolCallId);
            const exposedName = stringValue(event.toolName);
            if (!callId || !exposedName) continue;
            const tracked = activeTools.get(callId);
            const name = tracked?.name ?? bridge.originalName(exposedName);
            const result = eventType === "tool_execution_end" ? event.result : event.partialResult;
            const resultObject = object(result);
            const details = object(resultObject?.details);
            const evidence = boundedExecutionEvidence({
              input: tracked?.args ?? object(event.args),
              output: resultObject?.content,
              details: resultObject?.details,
              source: details?.source,
              ...fabricNestedCallEvidence(details),
              ...(typeof tracked?.args.code === "string" ? { code: tracked.args.code } : {}),
            });
            const status =
              eventType === "tool_execution_update"
                ? "started"
                : bridge.pausedCalls.has(callId)
                  ? "paused"
                  : event.isError === true
                    ? "failed"
                    : "completed";
            yield {
              type: "execution",
              executionId: `${request.runId}:${callId}`,
              name,
              participantId: request.runId,
              status,
              ...evidence.value,
              ...(evidence.truncated ? { truncated: true } : {}),
            };
            if (name === "fabric_exec") {
              yield* nestedFabricExecutionEvents(
                `${request.runId}:${callId}`,
                request.runId,
                evidence.value.nestedCalls,
                status,
              );
            }
            if (eventType === "tool_execution_end") activeTools.delete(callId);
            continue;
          }
          if (eventType === "compaction_start" || eventType === "compaction_end") {
            const compactionFailed =
              eventType === "compaction_end" &&
              (event.aborted === true ||
                event.error !== undefined ||
                object(event.result)?.error !== undefined);
            yield {
              type: "runtime_activity",
              activity: "compaction",
              status:
                eventType === "compaction_start"
                  ? "started"
                  : compactionFailed
                    ? "failed"
                    : "completed",
              state: boundedExecutionEvidence(event).value,
            };
            yield {
              type: "progress",
              text:
                eventType === "compaction_start"
                  ? "Compacting context"
                  : compactionFailed
                    ? "Context compaction failed"
                    : "",
              activity: true,
            };
            continue;
          }
          if (eventType === "auto_retry_start" || eventType === "auto_retry_end") {
            yield {
              type: "runtime_activity",
              activity: "retry",
              status:
                eventType === "auto_retry_start"
                  ? "started"
                  : event.success === false
                    ? "failed"
                    : "completed",
              state: boundedExecutionEvidence(event).value,
            };
            continue;
          }
          if (eventType === "queue_update") {
            const queued = [event.steering, event.followUp]
              .filter(Array.isArray)
              .reduce((count, values) => count + (values as unknown[]).length, 0);
            yield {
              type: "runtime_activity",
              activity: "queue",
              status: queued ? "started" : "completed",
              state: { pending: queued },
            };
            continue;
          }
          if (eventType !== "agent_settled") continue;

          if (fatalError) throw fatalError;
          if (gracefulPaused) {
            await runBoundary("paused");
            await saveCheckpoint();
            yield { type: "runtime_activity", activity: "queue", status: "paused" };
            finished = true;
            break;
          }
          if (terminalFailure) throw terminalFailure;
          const followUps = [...(await runBoundary("settled")), ...(await runBoundary("idle"))];
          if (pendingCompact) {
            pendingCompact = false;
            const result = await compact();
            if (result.outcome !== "completed") throw new Error(result.error);
          }
          await saveCheckpoint();
          if (followUps.length) {
            await sendPrompt(followUps);
            continue;
          }
          await saveCheckpoint({
            pendingSourceMessageId: undefined,
            lastCompletedSourceMessageId: sourceKey,
          });
          finished = true;
          break;
        }
        if (!finished) throw new Error("Pi RPC ended without agent_settled");
        if (!text.trim() && !gracefulPaused && !request.allowSilentEmpty) {
          text = request.emptyResponseText?.trim() || "No response. Try again.";
          yield { type: "text", text };
        }
        yield text ? { type: "done", text } : { type: "done" };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      await stopChild(signal.aborted || gracefulPaused || fatalError !== undefined).catch(
        () => undefined,
      );
      await bridge.close().catch(() => undefined);
      await session.release().catch(() => undefined);
    }
  }
}
