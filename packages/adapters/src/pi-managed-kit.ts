import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentSessionRuntime,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  type ResourceLoader,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolvePiKit } from "@rakazo/pi-kit";
import { createManagedFovea } from "./pi-managed-fovea.js";
import { managedMemoryProvider } from "./pi-managed-memory.js";
import { createBrokerCall, managedCoreTools } from "./pi-managed-tools.js";

export interface ManagedKitOptions {
  instructions: string;
  proxyTools: ToolDefinition[];
  restore?: unknown;
  checkpoint(): Promise<void>;
  activity(
    activity: "compaction" | "retry" | "queue",
    status: "started" | "completed" | "paused",
    state?: unknown,
  ): Promise<void>;
  /** Host-owned isolated scratch; production worker cwd is /work. Never a computer project. */
  scratchRoot?: string;
  getPlacement?(): { cwd: string; worktreeId?: string } | undefined;
  idleTtlMs?: number;
  now?: () => number;
}
export interface ManagedKit {
  resourceLoader: ResourceLoader;
  tools: ToolDefinition[];
  activeTools: string[];
  unavailable: string[];
  initialize(runtime: AgentSessionRuntime): Promise<void>;
  beforeModel(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  setPlacement(placement: { cwd: string; worktreeId?: string }): Promise<void>;
  settle(): Promise<void>;
  pause(): Promise<void>;
  snapshot(): unknown;
  dispose(): Promise<void>;
}
interface SavedKit {
  version: 1;
  idleAt?: number;
  compactedSource?: string;
  pendingCompact?: { instructions?: string; reason: string };
  retry?: { status: string; retryId?: number };
  graph?: unknown;
}

/** Process-scoped: the supervisor supplies a fresh isolated worker, never the backend process. */
export async function createManagedKit(options: ManagedKitOptions): Promise<ManagedKit> {
  const installation = resolvePiKit();
  const scratch = await mkdtemp(join(options.scratchRoot ?? process.cwd(), ".rakazo-kit-"));
  const agentDir = join(scratch, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Fabric host mode receives immutable authority from the factory, never a config file.
  const saved =
    options.restore &&
    typeof options.restore === "object" &&
    "version" in options.restore &&
    options.restore.version === 1
      ? (options.restore as SavedKit)
      : { version: 1 as const };
  const state: SavedKit = { ...saved };
  let runtime: AgentSessionRuntime | undefined;
  let context: ExtensionContext | undefined;
  let paused = false;
  let disposed = false;
  let retryDone: Promise<void> | undefined;
  let finishRetry: (() => void) | undefined;
  let reporting = Promise.resolve();
  const now = options.now ?? Date.now;
  const report = (
    activity: "retry" | "queue" | "compaction",
    status: "started" | "completed" | "paused",
    data?: unknown,
  ) => {
    reporting = reporting.then(() => options.activity(activity, status, data));
    // EventBus notifications are synchronous; retain failures for awaited boundaries without
    // an unhandled rejection if the private bridge disappears between events.
    void reporting.catch(() => undefined);
    return reporting;
  };
  const call = createBrokerCall(options.proxyTools, () => paused || disposed);
  const graph = createManagedFovea(
    join(scratch, "graph"),
    join(dirname(installation.extensionPaths[1]!), "core", "ops.ts"),
    call,
    state.graph,
    options.getPlacement?.(),
  );
  const core = managedCoreTools(call);
  const eventBus = createEventBus();
  const provider = (
    name: string,
    actions: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      risk: string;
    }>,
    invoke: (
      name: string,
      args: Record<string, unknown>,
      ctx: { signal?: AbortSignal; extensionContext: ExtensionContext },
    ) => Promise<unknown>,
    prepareArguments?: (name: string, args: Record<string, unknown>) => Record<string, unknown>,
  ) => ({
    name,
    description: `Managed ${name}`,
    list: async () => actions,
    describe: async (name: string) => actions.find((action) => action.name === name),
    invoke,
    ...(prepareArguments ? { prepareArguments } : {}),
  });
  const delegate = options.proxyTools.find((tool) => tool.name === "run_subagent");
  const providers = [
    managedMemoryProvider(() => runtime),
    ...["schema", "state", "mesh", "mcp"].map((name) =>
      provider(name, [], async () => {
        throw new Error("Native provider unavailable in managed execution");
      }),
    ),
    provider(
      "agents",
      delegate
        ? [
            {
              name: "run",
              description:
                "Delegate a scoped task through the backend subagent authority. No local process, model credentials, or widened computer scope.",
              inputSchema: delegate.parameters as Record<string, unknown>,
              risk: "agent",
            },
          ]
        : [],
      async (name, args, ctx) => {
        if (name !== "run") throw new Error("Only scoped agents.run is available");
        return call("run_subagent", args, ctx.signal, ctx.extensionContext);
      },
      (_name, args) => ({ name: "helper", ...args }),
    ),
    provider(
      "compact",
      [
        {
          name: "request",
          description: "Request deterministic Fabric compaction at the next idle boundary.",
          inputSchema: {
            type: "object",
            properties: {
              reason: { type: "string", maxLength: 1024 },
              instructions: { type: "string", maxLength: 8192 },
            },
            additionalProperties: false,
          },
          risk: "write",
        },
        ...["status", "cancel"].map((name) => ({
          name,
          description: "Inspect or cancel the pending idle compaction intent.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          risk: name === "status" ? "read" : "write",
        })),
      ],
      async (name, args) => {
        if (paused || disposed) throw new Error("Managed execution paused");
        if (name === "status") return { pending: state.pendingCompact };
        if (name === "cancel") {
          delete state.pendingCompact;
          return { cancelled: true };
        }
        if (name !== "request") throw new Error("Unknown compaction action");
        if (args.instructions === "__pi_vcc__")
          throw new Error("Compaction engine override is not permitted");
        state.pendingCompact = {
          reason: String(args.reason ?? "requested"),
          ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}),
        };
        return { requested: true, intent: state.pendingCompact };
      },
    ),
  ];
  const publishProviders = () => {
    for (const provider of providers)
      eventBus.emit("pi-fabric:provider:register:v1", { version: 1, provider, overwrite: true });
  };
  const unsubscribers = [
    eventBus.on("pi-retry:started", (event: unknown) => {
      const data = event as { retryId: number };
      state.retry = { status: "started", retryId: data.retryId };
      retryDone = new Promise<void>((resolve) => {
        finishRetry = resolve;
      });
      void report("retry", "started", state.retry);
    }),
    ...["completed", "cancelled"].map((status) =>
      eventBus.on(`pi-retry:${status}`, () => {
        state.retry = { ...state.retry, status };
        void report("retry", status === "completed" ? "completed" : "paused", state.retry);
        finishRetry?.();
        finishRetry = undefined;
        retryDone = undefined;
      }),
    ),
  ];
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir,
    eventBus,
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [] }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [installation.extensionPaths[3]!],
    systemPrompt: options.instructions,
    extensionFactories: [
      {
        name: "fabric-managed",
        factory: async (pi) => {
          const fabric = await import(pathToFileURL(installation.extensionPaths[0]!).href);
          if (fabric.FABRIC_MANAGED_HOST_VERSION !== 1)
            throw new Error("Pinned Fabric lacks required managed-host authority support");
          await fabric.default(pi, {
            managedHost: { providers: providers.map((provider) => provider.name) },
          });
        },
      },
      {
        name: "rakazo-managed",
        factory: (pi) => {
          for (const tool of [...core, ...options.proxyTools, ...graph.tools])
            pi.registerTool(tool);
          publishProviders();
          pi.on("session_start", (_event, ctx) => {
            context = ctx;
            publishProviders();
          });
          pi.on("tool_call", async (event) => {
            if (paused || disposed) return { block: true, reason: "Managed execution paused" };
            await report("queue", "started", {
              kind: "execution",
              toolCallId: event.toolCallId,
              name: event.toolName,
              input: event.input,
            });
            return undefined;
          });
          pi.on("tool_result", async (event) => {
            await report("queue", event.isError ? "paused" : "completed", {
              kind: "execution",
              toolCallId: event.toolCallId,
              name: event.toolName,
              content: event.content,
              details: event.details,
              isError: event.isError,
            });
          });
          pi.on("session_before_compact", async () => {
            await report("compaction", "started", { engine: "fabric" });
          });
          pi.on("session_compact", async () => {
            await report("compaction", "completed", { engine: "fabric" });
            await options.checkpoint();
          });
          pi.on("session_compact_failed", async () => {
            await report("compaction", "paused", { engine: "fabric" });
          });
        },
      },
    ],
  });
  try {
    await loader.reload();
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    throw error;
  }
  if (loader.getExtensions().errors.length)
    throw new Error(
      `Managed extension load failed: ${loader
        .getExtensions()
        .errors.map((error) => error.error)
        .join("; ")}`,
    );
  const resourceLoader: ResourceLoader = {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    // SDK always publishes extension resource suggestions while binding. The managed
    // catalog deliberately ignores them: no host skill paths or project resources enter prompts.
    extendResources: () => undefined,
    reload: async () => {
      throw new Error("Managed reload requires a new isolated worker");
    },
  };
  const source = () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          runtime?.session.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message" || entry.type === "custom_message"),
        ),
      )
      .digest("hex");
  const compactIdle = async () => {
    if (!runtime || paused || !state.pendingCompact) return;
    if (runtime.session.isStreaming) throw new Error("Idle compaction cannot run during a turn");
    const fingerprint = source();
    if (fingerprint === state.compactedSource) {
      delete state.pendingCompact;
      return;
    }
    // Public session API invokes the pinned Fabric session_before_compact handler, not an LLM summary.
    const instructions = state.pendingCompact.instructions;
    if (instructions === "__pi_vcc__")
      throw new Error("Compaction engine override is not permitted");
    try {
      await runtime.session.compact(instructions);
    } catch (error) {
      // Public Pi API reports an unchanged/small deterministic window as cancellation.
      // Never fall back to a paid summary, and never suppress broker/lease/model failures.
      if (
        paused ||
        !(error instanceof Error) ||
        !["Nothing to compact (session too small)", "Compaction cancelled"].includes(error.message)
      )
        throw error;
    }
    state.compactedSource = fingerprint;
    delete state.pendingCompact;
    await options.checkpoint();
  };
  const pause = async () => {
    paused = true;
    // pi-retry's public turn_end lifecycle observes aborted stops, including while its timer sleeps.
    const retry = loader
      .getExtensions()
      .extensions.find((extension) => extension.path === installation.extensionPaths[3]);
    for (const handler of retry?.handlers.get("turn_end") ?? [])
      await handler(
        { type: "turn_end", message: { role: "assistant", stopReason: "aborted" } },
        context ?? runtime?.session.extensionRunner.createContext(),
      );
    runtime?.session.abortCompaction();
    await report("queue", "paused", { kind: "authority-latch" });
  };
  return {
    resourceLoader,
    tools: [],
    activeTools: ["fabric_exec"],
    unavailable: ["ambient-plugins", "native-mcp", "native-node", "native-mesh"],
    async initialize(value) {
      runtime = value;
      context = runtime.session.extensionRunner.createContext();
      runtime.session.setActiveToolsByName(["fabric_exec"]);
      if (typeof state.idleAt === "number" && now() - state.idleAt >= (options.idleTtlMs ?? 300000))
        state.pendingCompact ??= { reason: "idle-ttl" };
      await compactIdle();
    },
    async setPlacement(placement) {
      if (paused || disposed) throw new Error("Managed execution paused");
      await graph.setPlacement(placement);
    },
    async compact(instructions) {
      if (paused || disposed) throw new Error("Managed execution paused");
      if (!runtime || runtime.session.isStreaming)
        throw new Error("Compaction requires an idle participant");
      if (instructions === "__pi_vcc__")
        throw new Error("Compaction engine override is not permitted");
      state.pendingCompact = { reason: "queue-command", instructions };
      await options.checkpoint();
      await compactIdle();
      await reporting;
    },
    async beforeModel() {
      if (paused || disposed) throw new Error("Managed execution paused");
      await reporting;
    },
    async settle() {
      await retryDone;
      await runtime?.session.agent.waitForIdle();
      await compactIdle();
      state.idleAt = now();
      await reporting;
    },
    pause,
    snapshot: () => ({ ...state, graph: graph.snapshot() }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const stopped = await Promise.allSettled([pause(), runtime?.session.abort()]);
      try {
        await retryDone;
        await graph.dispose();
      } finally {
        for (const unsubscribe of unsubscribers) unsubscribe();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(scratch, { recursive: true, force: true });
      }
      await reporting;
      for (const result of stopped) if (result.status === "rejected") throw result.reason;
    },
  };
}
