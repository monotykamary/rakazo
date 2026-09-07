import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  estimateTokens,
  type FileEntry,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ModelSelectionStatus, ModelSelectionStatusSchema } from "@rakazo/contracts";
import { resolvePiKit } from "@rakazo/pi-kit";
import { boundedExecutionEvidence } from "./pi-execution-evidence.js";
import { createManagedKit, type ManagedKit } from "./pi-managed-kit.js";
import { type JsonRecord, type PrivateDuplex, record, string } from "./pi-rpc-protocol.js";
import { JsonPeer, readJsonFrames } from "./pi-rpc-transport.js";
import { pruneComputerScreenshotContext } from "./pi-runtime.js";
import { prepareManagedToolArguments } from "./pi-tool-arguments.js";

const CORE_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;

/** Stock RPC is process stdio; the separate private duplex is injected by the isolated entrypoint. */
export async function runManagedPiWorker(bridgePort: PrivateDuplex): Promise<never> {
  const writeRpc = process.stdout.write.bind(process.stdout);
  let runtime: AgentSessionRuntime | undefined;
  let initialized = false;
  let managedKit: ManagedKit | undefined;
  let paused = false;
  let terminalModelFailure = false;
  let atBoundary = false;
  let deliveryWork: Promise<void> | undefined;
  const boundaryMessages: import("@earendil-works/pi-agent-core").AgentMessage[] = [];
  let kitState: unknown;
  let placement: { cwd: string; worktreeId?: string } | undefined;
  let sourceMessageIds = new Set<string>();
  let modelSelection: ModelSelectionStatus | undefined;
  let committedModel: Model<Api> | undefined;
  let committedThinking: string | undefined;
  let requestedModel: Model<Api> | undefined;
  let modelControlBusy = false;
  const streams = new Map<string, AssistantMessageEventStream>();
  const kit = resolvePiKit();
  let ready!: () => void;
  const initializedPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const checkpoint = async (extra?: FileEntry) => {
    if (!runtime) throw new Error("Managed runtime unavailable");
    const manager = runtime.session.sessionManager;
    const entries = manager.getEntries();
    await peer.request("checkpoint", {
      version: 1,
      runtimeVersion: kit.runtimeVersion,
      header: manager.getHeader(),
      entries: extra ? [...entries, extra] : entries,
      leafId: extra && "id" in extra ? extra.id : manager.getLeafId(),
      sourceMessageIds: [...sourceMessageIds],
      modelSelection,
      modelConfiguration: committedModel
        ? { model: committedModel, thinkingLevel: committedThinking }
        : undefined,
      placement,
      kitState: { queue: kitState, managed: managedKit?.snapshot() },
    });
  };
  const deliverModelEvent = async (
    stream: AssistantMessageEventStream,
    event: AssistantMessageEvent,
  ) => {
    if (event.type === "error" && event.reason !== "aborted" && !paused) {
      // A final broker failure has exhausted the authorized attempt policy.
      terminalModelFailure = true;
      paused = true;
      try {
        await managedKit?.pause();
      } catch {
        /* The local pause latch still blocks every new model/tool request. */
      } finally {
        stream.push(event);
      }
    } else stream.push(event);
  };
  const brokerStream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const streamId = randomUUID();
    streams.set(streamId, stream);
    const abort = () => {
      void peer.request("model_cancel", { streamId }).catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    void peer
      .request("model", {
        streamId,
        context,
        options: { maxTokens: options?.maxTokens, temperature: options?.temperature },
      })
      .catch(() => {
        void deliverModelEvent(stream, {
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: options?.signal?.aborted ? "aborted" : "error",
            errorMessage: "Managed model broker stopped",
            timestamp: Date.now(),
          },
        });
      })
      .finally(() => {
        streams.delete(streamId);
        options?.signal?.removeEventListener("abort", abort);
      });
    return stream;
  };
  const handler = async (message: JsonRecord): Promise<unknown> => {
    if (message.operation === "shutdown") {
      paused = true;
      await managedKit?.dispose();
      await runtime?.dispose();
      return { stopped: true };
    }
    if (message.operation === "pause") {
      paused = true;
      await managedKit?.pause();
      await checkpoint();
      return { paused: true };
    }
    if (message.operation === "model_selection") {
      if (!runtime || runtime.session.isStreaming || modelControlBusy)
        throw new Error("Model selection requires an idle participant");
      const next = ModelSelectionStatusSchema.parse(message.data);
      const previous = {
        model: committedModel,
        thinking: committedThinking,
        selection: modelSelection,
      };
      if (next.status === "applied") {
        committedModel = runtime.session.model;
        committedThinking = runtime.session.thinkingLevel;
      } else if (next.status === "failed" && committedModel) {
        await runtime.session.setModel(committedModel);
        runtime.session.setThinkingLevel(committedThinking as never);
      }
      modelSelection = next;
      try {
        await checkpoint();
      } catch (error) {
        committedModel = previous.model;
        committedThinking = previous.thinking;
        modelSelection = previous.selection;
        throw error;
      }
      return { saved: true };
    }
    if (message.operation === "deliver") {
      if (!runtime || paused) throw new Error("Participant unavailable for queue delivery");
      const data = record(message.data);
      if (data.placement && JSON.stringify(data.placement) !== JSON.stringify(placement)) {
        const next = record(data.placement) as { cwd: string; worktreeId?: string };
        const change = (
          managedKit as ManagedKit & {
            setPlacement?: (placement: { cwd: string; worktreeId?: string }) => Promise<void>;
          }
        ).setPlacement;
        if (!change) throw new Error("Managed kit cannot safely switch project snapshots");
        await change(next);
        placement = next;
      }
      const messageId = string(data.messageId);
      if (sourceMessageIds.has(messageId)) return { delivered: true };
      const text = String(data.text ?? "");
      const images = Array.isArray(data.images) ? data.images : [];
      if (runtime.session.isStreaming) {
        if (!atBoundary) throw new Error("Participant is not at a safe delivery boundary");
        const user = {
          role: "user" as const,
          content: [{ type: "text" as const, text }, ...images] as never,
          timestamp: Date.now(),
        };
        runtime.session.sessionManager.appendMessage(user);
        runtime.session.agent.state.messages = [...runtime.session.agent.state.messages, user];
        boundaryMessages.push(user);
        sourceMessageIds.add(messageId);
        await checkpoint();
      } else {
        sourceMessageIds.add(messageId);
        let acknowledge!: () => void;
        let reject!: (error: unknown) => void;
        const accepted = new Promise<void>((resolve, fail) => {
          acknowledge = resolve;
          reject = fail;
        });
        const unsubscribe = runtime.session.subscribe((event) => {
          if (event.type === "message_end" && event.message.role === "user") acknowledge();
        });
        deliveryWork = runtime.session.prompt(`User request:\n${text}`, {
          images: images as never,
          expandPromptTemplates: false,
        });
        void deliveryWork.catch((error) => {
          reject(error);
          void peer.send({ type: "worker_error" }).catch(() => undefined);
        });
        try {
          // SessionManager appends the user entry before this continuation runs.
          // Acknowledge durable acceptance, not eventual model completion.
          await accepted;
          await checkpoint();
        } finally {
          unsubscribe();
        }
      }
      return { delivered: true };
    }
    if (message.operation === "compact") {
      if (!runtime || !managedKit || paused)
        throw new Error("Participant unavailable for compaction");
      const data = record(message.data);
      if (
        data.instructions !== undefined &&
        (typeof data.instructions !== "string" || data.instructions.length > 8192)
      )
        throw new Error("Invalid compaction instructions");
      await managedKit.compact(data.instructions as string | undefined);
      await checkpoint();
      return { outcome: "completed" };
    }
    if (message.operation === "finish") {
      if (!runtime) throw new Error("Worker is not initialized");
      const data = record(message.data);
      await deliveryWork;
      await runtime.session.agent.waitForIdle();
      await managedKit?.settle();
      if (terminalModelFailure || (runtime.session.agent.state.errorMessage && !paused)) {
        await checkpoint();
        throw new Error("Managed model execution failed");
      }
      kitState = data.state ?? kitState;
      if (data.compact === true && !paused) await runtime.session.compact();
      await checkpoint();
      return { saved: true };
    }
    if (message.operation !== "initialize" || initialized)
      throw new Error("Invalid worker operation");
    initialized = true;
    const data = record(message.data);
    if (data.version !== 1 || !Array.isArray(data.tools) || !Array.isArray(data.history))
      throw new Error("Invalid managed bootstrap");
    placement = data.placement
      ? (record(data.placement) as { cwd: string; worktreeId?: string })
      : undefined;
    requestedModel = record(data.model) as unknown as Model<Api>;
    const restore = data.restore === undefined ? undefined : record(data.restore);
    const savedConfiguration = record(restore?.modelConfiguration ?? {});
    const model = savedConfiguration.model
      ? (record(savedConfiguration.model) as unknown as Model<Api>)
      : requestedModel;
    committedModel = model;
    committedThinking = String(savedConfiguration.thinkingLevel ?? data.thinkingLevel);
    const savedSelection = ModelSelectionStatusSchema.safeParse(restore?.modelSelection);
    modelSelection = savedSelection.success ? savedSelection.data : undefined;
    if (
      restore &&
      (restore.version !== 1 ||
        restore.runtimeVersion !== kit.runtimeVersion ||
        !Array.isArray(restore.entries) ||
        !Array.isArray(restore.sourceMessageIds))
    )
      throw new Error("Unsupported managed checkpoint");
    // Supervisor cwd is isolated scratch; computer tools never use this SDK state directory.
    const cwd = process.cwd();
    const agentDir = `${cwd}/.pi`;
    const manager = restore
      ? SessionManager.inMemory(cwd, undefined, [
          record(restore.header),
          ...(restore.entries as FileEntry[]),
        ] as FileEntry[])
      : SessionManager.inMemory(cwd);
    if (restore?.leafId === null) manager.resetLeaf();
    else if (restore?.leafId) manager.branch(string(restore.leafId));
    sourceMessageIds = new Set(restore ? (restore.sourceMessageIds as unknown[]).map(string) : []);
    kitState = restore?.kitState ? record(restore.kitState).queue : undefined;
    for (const id of Array.isArray(data.initialMessageIds) ? data.initialMessageIds : []) {
      if (typeof id === "string") sourceMessageIds.add(id);
    }
    for (const value of data.history) {
      const item = record(value);
      if (
        item.id === data.sourceMessageId ||
        (typeof item.id === "string" && sourceMessageIds.has(item.id))
      )
        continue;
      // Unidentified legacy history is imported once, never stacked on a restored Pi context.
      if (restore && (typeof item.id !== "string" || item.role === "assistant")) continue;
      if (item.role === "user" || item.role === "assistant")
        manager.appendMessage({
          role: "user",
          content: `${item.role === "assistant" ? "Assistant: " : ""}${String(item.content)}`,
          timestamp: Date.now(),
        });
      if (typeof item.id === "string") sourceMessageIds.add(item.id);
    }
    if (typeof data.sourceMessageId === "string") sourceMessageIds.add(data.sourceMessageId);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("rakazo-broker", {
      baseUrl: "http://broker.invalid",
      api: "openai-completions",
      apiKey: "broker",
      models: model.id === requestedModel.id ? [requestedModel] : [model, requestedModel],
      streamSimple: brokerStream,
    });
    // Both normal turns and SDK compaction must use the private broker, not network adapters.
    modelRuntime.streamSimple = brokerStream;
    modelRuntime.stream = (m, ctx, options) =>
      brokerStream(m, ctx, {
        signal: options?.signal,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
      });
    modelRuntime.completeSimple = (m, ctx, options) => brokerStream(m, ctx, options).result();
    modelRuntime.complete = (m, ctx, options) => modelRuntime.stream(m, ctx, options).result();
    const proxies: ToolDefinition[] = data.tools.map((value) => {
      const tool = record(value);
      const name = string(tool.name);
      if (CORE_TOOLS.some((core) => core === name))
        throw new Error("Managed tool collides with reserved native tool");
      return {
        name,
        label: name,
        description: String(tool.description),
        prepareArguments: (args) => prepareManagedToolArguments(String(tool.argumentKind), args),
        parameters: tool.parameters as ToolDefinition["parameters"],
        async execute(callId, args, signal) {
          if (paused) throw new Error("Managed run is paused");
          signal?.throwIfAborted();
          await checkpoint();
          const response = record(
            await peer.request("tool", { handle: string(tool.handle), callId, args }),
          );
          const result = record(response.result);
          if (response.paused === true) {
            paused = true;
            await managedKit?.pause();
            const sm = runtime!.session.sessionManager;
            // Save the paused result before releasing it to Pi or publishing product interaction.
            await checkpoint({
              type: "message",
              id: randomUUID(),
              parentId: sm.getLeafId(),
              timestamp: new Date().toISOString(),
              message: {
                role: "toolResult",
                toolCallId: callId,
                toolName: name,
                content: result.content as never,
                details: result.details,
                isError: response.isError === true,
                timestamp: Date.now(),
              },
            });
          }
          if (response.isError === true)
            throw new Error(
              Array.isArray(result.content)
                ? result.content
                    .map((item) => record(item).text)
                    .filter((text) => typeof text === "string")
                    .join("\n") || "Authorized tool execution failed"
                : "Authorized tool execution failed",
            );
          return {
            content: result.content as never,
            details: result.details,
            terminate: response.paused === true || result.terminate === true,
          };
        },
      };
    });
    managedKit = await createManagedKit({
      ...{ getPlacement: () => placement },
      instructions: String(data.instructions),
      proxyTools: proxies,
      restore: restore?.kitState ? record(restore.kitState).managed : undefined,
      // Root-only host memory authority; delegated children never see a host memory half.
      hostMemory:
        data.memory === true
          ? async (call) =>
              peer.request("memory", { action: call.action, args: call.args }, call.signal)
          : undefined,
      checkpoint,
      activity: (activity, status, state) => {
        const evidence = boundedExecutionEvidence(record(state ?? {}), 262144);
        return peer.send({
          type: "kit_activity",
          activity,
          status,
          state: { ...evidence.value, ...(evidence.truncated ? { truncated: true } : {}) },
        });
      },
    });
    const { resourceLoader } = managedKit;
    runtime = await createAgentSessionRuntime(
      async ({ sessionManager, sessionStartEvent }) => {
        const services = {
          cwd,
          agentDir,
          modelRuntime,
          settingsManager: settings,
          resourceLoader,
          diagnostics: [],
        };
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            model,
            thinkingLevel: committedThinking as never,
            tools: managedKit!.activeTools,
            noTools: "builtin",
            customTools: managedKit!.tools,
          })),
          services,
          diagnostics: [],
        };
      },
      { cwd, agentDir, sessionManager: manager },
    );
    await managedKit.initialize(runtime);
    const agent = runtime.session.agent;
    const transform = agent.transformContext;
    agent.transformContext = async (messages, signal) => {
      if (paused) throw new Error("Managed run is paused");
      await managedKit?.beforeModel();
      atBoundary = true;
      let boundary: JsonRecord;
      try {
        boundary = record(await peer.request("boundary", {}, signal));
      } finally {
        atBoundary = false;
      }
      kitState = boundary.state ?? kitState;
      if (paused) throw new Error("Managed run is paused");
      let imported = false;
      for (const value of Array.isArray(boundary.messages) ? boundary.messages : []) {
        const item = record(value);
        if (typeof item.messageId === "string" && sourceMessageIds.has(item.messageId)) continue;
        const images = Array.isArray(item.images) ? item.images : [];
        const user = {
          role: "user" as const,
          content: [{ type: "text" as const, text: String(item.text) }, ...images] as never,
          timestamp: Date.now(),
        };
        runtime!.session.sessionManager.appendMessage(user);
        agent.state.messages = [...agent.state.messages, user];
        boundaryMessages.push(user);
        if (typeof item.messageId === "string") sourceMessageIds.add(item.messageId);
        imported = true;
      }
      if (imported) await checkpoint();
      // This hook runs for the initial request too. Mutate the current loop context
      // before conversion, not a native steering queue that would defer delivery.
      messages.push(...boundaryMessages.splice(0));
      return pruneComputerScreenshotContext(
        transform ? await transform(messages, signal) : messages,
      );
    };
    const stopAfter = agent.shouldStopAfterTurn;
    agent.shouldStopAfterTurn = (ctx, signal) => paused || stopAfter?.(ctx, signal) || false;
    // Only the sealed managed kit is exposed through stock RPC.
    ready();
    return {
      version: 1,
      runtimeVersion: kit.runtimeVersion,
      nativeTools: false,
      unavailable: managedKit.unavailable,
      memory: data.memory === true,
    };
  };
  const peer = new JsonPeer(bridgePort, handler, (message) => {
    if (message.type === "model_event") {
      const stream = streams.get(string(message.streamId));
      const event = message.event as AssistantMessageEvent;
      if (stream) void deliverModelEvent(stream, event).catch(() => undefined);
    }
    if (message.type === "disconnected") {
      void managedKit?.dispose().finally(() => runtime?.dispose());
    }
  });
  await peer.send({ type: "hello", version: 1, runtimeVersion: kit.runtimeVersion });
  await initializedPromise;
  const input = process.stdin;
  const guarded = new PassThrough();
  Object.defineProperty(process, "stdin", { value: guarded, configurable: true });
  void (async () => {
    const port: PrivateDuplex = {
      incoming: input,
      write: async () => {
        throw new Error("Not writable");
      },
      close: async () => undefined,
    };
    for await (const frame of readJsonFrames(port)) {
      if (["compact", "set_model", "set_thinking_level"].includes(String(frame.type))) {
        try {
          if (!runtime || !managedKit || paused || runtime.session.isStreaming || modelControlBusy)
            throw new Error("Model control requires an idle participant");
          modelControlBusy = true;
          if (frame.type === "compact") {
            const previousModel = runtime.session.model;
            const previousThinking = runtime.session.thinkingLevel;
            try {
              // Fabric budgets against ctx.model. Stage only authorized target metadata;
              // no normal inference is accepted until the handoff is committed.
              if (requestedModel) await runtime.session.setModel(requestedModel);
              await managedKit.compact(undefined, { requireSuccess: true });
              // The SDK can label a huge unsplittable first turn "session too small".
              // A no-op is safe only if its actual live window fits the target reserve.
              const target = runtime.session.model;
              const reserve = Math.max(
                target?.maxTokens ?? 0,
                runtime.session.settingsManager.getCompactionSettings().reserveTokens,
              );
              const tokens = Math.max(
                runtime.session.getContextUsage()?.tokens ?? 0,
                runtime.session.messages.reduce(
                  (total, message) => total + estimateTokens(message),
                  0,
                ),
              );
              if (!target || tokens > target.contextWindow - reserve)
                throw new Error("Compaction did not fit the selected model window");
            } finally {
              if (previousModel) await runtime.session.setModel(previousModel);
              runtime.session.setThinkingLevel(previousThinking);
            }
          } else if (frame.type === "set_model") {
            if (
              !requestedModel ||
              frame.provider !== "rakazo-broker" ||
              frame.modelId !== requestedModel.id
            )
              throw new Error("Model is outside the authorized selection");
            await runtime.session.setModel(requestedModel);
          } else {
            const level = String(frame.level);
            if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
              throw new Error("Invalid thinking level");
            runtime.session.setThinkingLevel(level as never);
          }
          writeRpc(
            JSON.stringify({ id: frame.id, type: "response", command: frame.type, success: true }) +
              "\n",
          );
        } catch {
          writeRpc(
            JSON.stringify({
              id: frame.id,
              type: "response",
              command: frame.type,
              success: false,
              error: "Managed model control failed",
            }) + "\n",
          );
        } finally {
          modelControlBusy = false;
        }
        continue;
      }
      if (!["get_state", "prompt", "abort"].includes(String(frame.type)))
        throw new Error("Forbidden managed Pi command");
      if (
        frame.type === "prompt" &&
        (typeof frame.message !== "string" || !frame.message.startsWith("User request:\n"))
      )
        throw new Error("Forbidden managed prompt expansion");
      if (frame.type === "prompt") await managedKit?.beforeModel();
      if (frame.type === "abort") {
        paused = true;
        await managedKit?.pause();
      }
      if (!guarded.write(JSON.stringify(frame) + "\n"))
        await new Promise<void>((resolve) => guarded.once("drain", resolve));
    }
    guarded.end();
  })().catch(() => {
    guarded.destroy();
    void runtime?.dispose().finally(() => process.exit(1));
  });
  return runRpcMode(runtime!);
}

async function main() {
  const path = process.env.RAKAZO_AGENT_BRIDGE_SOCKET;
  if (!path) throw new Error("Private managed Pi bridge socket is required");
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const port: PrivateDuplex = {
    incoming: socket,
    write: (frame) =>
      new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => (error ? reject(error) : resolve()));
      }),
    close: async () => {
      socket.destroy();
    },
  };
  await runManagedPiWorker(port);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Managed Pi worker failed\n");
    process.exitCode = 1;
  });
}
