import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import {
  ModelSelectionStatusSchema,
  QueueControlCommandSchema,
  type QueueControlResult,
} from "@rakazo/contracts";
import type { AgentExecutionRequest } from "pi-fabric/agents";
import { workerSessionCheckpoint } from "./pi-agent-snapshot.js";
import {
  boundedExecutionEvidence,
  fabricNestedCallEvidence,
  nestedFabricExecutionEvents,
} from "./pi-execution-evidence.js";
import { applyManagedModelSelection } from "./pi-model-handoff.js";
import { NativeAgents } from "./pi-native-agents.js";
import { AgentsBridge } from "./pi-rpc-agents-bridge.js";
import { ModelBridge } from "./pi-rpc-model-bridge.js";
import { type AgentProcessHost, type JsonRecord, memoryAction, record } from "./pi-rpc-protocol.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import { AsyncChannel, JsonPeer } from "./pi-rpc-transport.js";
import { thinkingLevelFor, toPiImages } from "./pi-runtime.js";

export class ManagedPiRuntime implements AgentRuntime {
  private readonly running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();
  constructor(private readonly options: { host?: AgentProcessHost } = {}) {}
  describe() {
    return {
      id: "pi",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        scripted: false,
        memory: true,
      },
    };
  }
  async abort(runId: string) {
    const active = this.running.get(runId);
    active?.controller.abort();
    await active?.work;
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
        controller.abort();
        return events.return(undefined);
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }
  private async *events(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent> {
    if (!this.options.host)
      throw new Error("Pi requires an isolated AgentProcessHost; host execution is disabled");
    if (this.running.has(request.runId)) throw new Error("A managed Pi run is already active");
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const frozen = {
      ...request,
      tools: structuredClone(request.tools),
      history: structuredClone(request.history),
      model: { ...request.model },
    };
    const queue = new AsyncChannel<AgentRuntimeEvent>();
    const authority = new RunAuthority(frozen, signal);
    if (request.session?.restore) {
      const restored = record(request.session.restore);
      authority.rootState = { ...restored };
    }
    const agents = new NativeAgents(
      authority,
      (event) => queue.push(event),
      async (child, execution, parentExecutionId) => {
        let text = "";
        let turns = 0;
        let toolCalls = 0;
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let updates = Promise.resolve();
        await this.execute(
          child,
          context,
          authority,
          (event) => {
            if (event.type === "text") {
              text += event.text;
              const progress = text;
              updates = updates.then(() =>
                authority.paused ? undefined : execution.emit({ type: "progress", text: progress }),
              );
              void updates.catch(() => undefined);
            } else if (event.type !== "done") {
              if (event.type === "execution")
                event = {
                  ...event,
                  parentExecutionId: event.parentExecutionId ?? parentExecutionId,
                };
              if (event.type === "usage" || event.type === "tool") {
                if (event.type === "usage") {
                  usage.input += event.inputTokens;
                  usage.output += event.outputTokens;
                  turns++;
                } else toolCalls++;
                const progress = {
                  type: "progress" as const,
                  turns,
                  toolCalls,
                  usage: { ...usage },
                };
                updates = updates.then(() =>
                  authority.paused ? undefined : execution.emit(progress),
                );
                void updates.catch(() => undefined);
              }
              if (authority.paused) authority.deferredEvents.push(event);
              else queue.push(event);
            }
          },
          agents,
          execution,
          () => agents.pollRoot?.() ?? Promise.resolve(),
        ).catch((error: unknown) => {
          // A suspended admission may not yet have initialized a worker. Cleanup
          // has still completed; transport/cleanup failures must remain failures.
          if (
            !(
              authority.paused &&
              error instanceof Error &&
              error.message === "Managed run is paused"
            )
          )
            throw error;
        });
        await updates.catch((error: unknown) => {
          if (!authority.paused) throw error;
        });
        return { status: authority.paused ? "paused" : "completed", text, usage };
      },
    );
    const closeAgents = () => {
      void agents.service.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeAgents, { once: true });
    if (signal.aborted) closeAgents();
    const work = this.execute(frozen, context, authority, (event) => queue.push(event), agents)
      .finally(async () => {
        signal.removeEventListener("abort", closeAgents);
        await agents.service.close();
      })
      .catch((error: unknown) => {
        if (
          !signal.aborted ||
          (signal.reason instanceof Error && signal.reason.name === "TimeoutError")
        )
          queue.close(error instanceof Error ? error : new Error("Managed Pi failed"));
      })
      .finally(() => queue.close());
    const active = { controller, work };
    this.running.set(request.runId, active);
    try {
      yield* queue;
      signal.throwIfAborted();
    } finally {
      controller.abort();
      await work;
      if (this.running.get(request.runId) === active) this.running.delete(request.runId);
    }
  }
  private async execute(
    request: AgentRunRequest,
    context: Partial<AdapterContext> | undefined,
    authority: RunAuthority,
    emit: (event: AgentRuntimeEvent) => void,
    agents: NativeAgents,
    execution?: AgentExecutionRequest,
    pollRoot?: () => Promise<void>,
  ): Promise<void> {
    const depth = execution?.depth ?? 0;
    const signal = execution
      ? AbortSignal.any([authority.signal, execution.signal])
      : authority.signal;
    await authority.check();
    const scope = Object.freeze({
      runId: request.runId,
      rootRunId: authority.request.runId,
      leaseOwner: context?.runLease?.owner,
      leaseFence: context?.runLease?.fence,
      threadId: request.threadId,
      botId: request.botId,
      spaceId: context?.spaceId ?? "",
    });
    const broker = new ModelBridge(request, authority, emit);
    // Runtime owns graceful shutdown; the host must not reap before kit stop hooks finish.
    const lifetime = new AbortController();
    const connection = await this.options.host!.start(scope, lifetime.signal);
    let bridge: JsonPeer | undefined;
    let rpc: JsonPeer | undefined;
    let resolveSettled!: () => void;
    let rejectSettled!: (error: Error) => void;
    let resolveHello!: () => void;
    const hello = new Promise<void>((resolve) => {
      resolveHello = resolve;
    });
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    const helloTimer = setTimeout(
      () => rejectSettled(new Error("Isolated Pi readiness timed out")),
      30000,
    );
    // Attach a rejection handler before bootstrap can fail/disconnect.
    void settled.catch(() => undefined);
    let text = "";
    let bootstrapped = false;
    let rootPrompted = false;
    const deferredChildEvents = authority.deferredEvents;
    const tools = new ToolBridge(request, authority, emit, signal);
    agents.bindings.set(request.runId, { request, tools });
    const agentBridge = new AgentsBridge(async (action, args, waitSignal) => {
      try {
        await authority.check();
        if (!request.tools.some((tool) => tool.name === "run_subagent"))
          throw new Error("Delegation is outside this participant's tool scope");
        const result = await agents.dispatcher(request.runId)(action, args, waitSignal);
        await authority.check();
        return { result, paused: false };
      } catch (error) {
        if (!authority.paused) throw error;
        return { paused: true };
      }
    });
    const seen = new Set<string>();
    type BoundaryResult = Awaited<ReturnType<NonNullable<AgentRunRequest["runtimeBoundary"]>>>;
    let boundaryBusy = false;
    let parkDispatch: (() => void) | undefined;
    let backgroundBoundaryError: unknown;
    let dispatchWork: Promise<BoundaryResult> | undefined;
    const gateAbort = new AbortController();
    let pendingRootResult: BoundaryResult;
    const isScopedParticipant = (target: string) => {
      const visited = new Set<string>();
      while (target !== authority.request.runId) {
        if (visited.has(target)) return false;
        visited.add(target);
        const participant = agents.entry(target)?.record;
        if (!participant) return false;
        target = participant.parentId;
      }
      return true;
    };
    const dispatchBoundary = async (name: "before_model" | "settled" | "idle" | "paused") => {
      // A dispatch may itself await a resumed child. Never reenter or wait on that dispatch.
      if (backgroundBoundaryError) throw backgroundBoundaryError;
      if (!bootstrapped || boundaryBusy) return;
      boundaryBusy = true;
      let isParked = false;
      const parked = new Promise<void>((resolve) => {
        parkDispatch = () => {
          isParked = true;
          resolve();
        };
      });
      const work = (async () => {
        try {
          return await request.runtimeBoundary?.(name, {
            participantId: request.runId,
            deliver: async (message) => {
              await authority.check();
              const target = message.participantId ?? authority.request.runId;
              if (!isScopedParticipant(target))
                throw new Error("Participant is outside this session's authority");
              if (
                message.placement &&
                target !== request.runId &&
                authority.workerBridges.has(target)
              )
                throw new Error("Cannot replace a live child placement");
              if (message.placement && target === request.runId) {
                if (!request.authorizeSubagentPlacement)
                  throw new Error("Queued placement authorization is unavailable");
                const authorized = await authority.serialize(() =>
                  request.authorizeSubagentPlacement!(message.placement!, target),
                );
                request.executeTool = authorized.executeTool;
                request.placement = authorized.placement;
              }
              const targetPeer = authority.workerBridges.get(target);
              if (!targetPeer) {
                await agents.deliver(target, message);
              } else {
                await targetPeer.request(
                  "deliver",
                  {
                    id: message.id,
                    messageId: message.messageId,
                    text: message.text,
                    images: toPiImages(message.images),
                    placement: message.placement,
                  },
                  signal,
                );
              }
              await authority.check();
              if (target === request.runId) rootPrompted = true;
            },
            command: async (input, options): Promise<QueueControlResult> => {
              const parsed = QueueControlCommandSchema.safeParse(input);
              if (!parsed.success)
                return { outcome: "rejected", error: "Unsupported runtime command" };
              const command = parsed.data;
              const commandSignal = AbortSignal.any([signal, options.signal, gateAbort.signal]);
              commandSignal.throwIfAborted();
              await authority.check();
              const target = command.participantId ?? authority.request.runId;
              if (!isScopedParticipant(target))
                return {
                  outcome: "rejected",
                  error: "Participant is outside this session's authority",
                };
              if (command.kind === "participant-await") {
                if (target === authority.request.runId)
                  return { outcome: "rejected", error: "Cannot await the current root" };
                const participant = agents.entry(target)?.record;
                if (!participant) return { outcome: "rejected", error: "Unknown participant" };
                parkDispatch?.();
                try {
                  const result = await agents.service.wait(
                    participant.parentId,
                    target,
                    commandSignal,
                  );
                  commandSignal.throwIfAborted();
                  await authority.check();
                  return result.status === "completed"
                    ? { outcome: "completed" }
                    : {
                        outcome: "rejected",
                        error: "Participant requires resume or reconciliation",
                      };
                } catch {
                  commandSignal.throwIfAborted();
                  return { outcome: "rejected", error: "Participant did not complete" };
                }
              }
              if (command.kind === "fabric-prewalk") return { outcome: "completed" };
              if (command.kind === "new")
                return {
                  outcome: "rejected",
                  error: "Queued /new is unavailable here; start a new conversation instead",
                };
              if (command.kind === "model" || command.kind === "thinking") {
                if (!request.resolveParticipantModel)
                  return { outcome: "rejected", error: "Worker model selection requires backend authorization" };
                try {
                  const current =
                    (await request.resolveParticipantModel(target)) ?? request.model;
                  const selection =
                    command.kind === "model"
                      ? {
                          provider: command.target.slice(0, command.target.indexOf("/")),
                          modelId: command.target.slice(command.target.indexOf("/") + 1),
                          thinkingLevel: current.thinkingLevel ?? null,
                        }
                      : {
                          provider: current.provider,
                          modelId: current.id,
                          thinkingLevel: command.level,
                        };
                  await request.resolveParticipantModel(target, selection);
                  commandSignal.throwIfAborted();
                  return { outcome: "completed" };
                } catch (error) {
                  return {
                    outcome: "rejected",
                    error: error instanceof Error ? error.message : "Model command failed",
                  };
                }
              }
              const peer = authority.workerBridges.get(target);
              if (!peer) return { outcome: "rejected", error: "Participant is not active" };
              commandSignal.throwIfAborted();
              try {
                if (command.kind === "reload") {
                  try {
                    const result = record(await peer.request("reload", {}, commandSignal));
                    if (result.outcome === "completed" || result.reloaded === true)
                      return { outcome: "completed" };
                    if (result.outcome === "rejected")
                      return { outcome: "rejected", error: "Runtime reload rejected" };
                    return {
                      outcome: "uncertain",
                      error: "Runtime reload completion was not confirmed",
                    };
                  } catch {
                    return { outcome: "rejected", error: "Runtime reload is unavailable" };
                  }
                }
                if (target !== authority.request.runId) {
                  const participant = agents.entry(target)!.record;
                  await agents.service.compact(participant.parentId, target, command.instructions);
                  commandSignal.throwIfAborted();
                  return { outcome: "completed" };
                }
                const result = record(
                  await peer.request(
                    "compact",
                    { instructions: command.instructions },
                    commandSignal,
                  ),
                );
                if (result.outcome === "completed") return { outcome: "completed" };
                if (result.outcome === "rejected")
                  return { outcome: "rejected", error: "Runtime command rejected" };
                return {
                  outcome: "uncertain",
                  error: "Runtime command completion was not confirmed",
                };
              } catch {
                return {
                  outcome: "uncertain",
                  error: "Runtime command completion was not confirmed",
                };
              }
            },
            pause: async () => {
              gateAbort.abort();
              authority.gracefulPause = true;
              authority.paused = true;
              await bridge!.request("pause", {}, signal);
            },
          });
        } finally {
          boundaryBusy = false;
          parkDispatch = undefined;
        }
      })();
      dispatchWork = work;
      void work.then(
        (result) => {
          if (isParked) pendingRootResult = mergeBoundaryResults(pendingRootResult, result);
        },
        (error) => {
          backgroundBoundaryError = error;
        },
      );
      return Promise.race([work, parked.then(() => undefined)]);
    };
    const mergeBoundaryResults = (previous: BoundaryResult, next: BoundaryResult) => ({
      compact: previous?.compact || next?.compact,
      state: next?.state ?? previous?.state,
      messages: [...(previous?.messages ?? []), ...(next?.messages ?? [])],
    });
    const pollFromChild = async () => {
      // Poll at a child model boundary without claiming root steering into the child.
      const result = await dispatchBoundary("before_model");
      pendingRootResult = mergeBoundaryResults(pendingRootResult, result);
    };
    if (!depth) agents.pollRoot = pollFromChild;
    const boundary = async (name: "before_model" | "settled" | "idle" | "paused") => {
      if (name !== "paused") await authority.check();
      if (pollRoot && bootstrapped && name === "before_model") await pollRoot();
      const dispatched = pollRoot ? undefined : await dispatchBoundary(name);
      const result = pollRoot ? undefined : mergeBoundaryResults(pendingRootResult, dispatched);
      if (!pollRoot) pendingRootResult = undefined;
      const steering =
        name === "before_model" ? ((await request.claimSteering?.([...seen])) ?? []) : [];
      await authority.checkLease(false, name === "paused");
      if (authority.paused) return { compact: false, state: result?.state, messages: [] };
      const messages = [...steering, ...(result?.messages ?? [])].filter(
        (item) => !seen.has(item.id),
      );
      for (const item of messages) seen.add(item.id);
      return {
        compact: result?.compact,
        state: result?.state,
        messages: messages.map((item) => ({ ...item, images: toPiImages(item.images) })),
      };
    };
    // Host-backed source memory crosses the same authenticated bridge and authority as tools.
    const serveMemory = async (data: unknown) => {
      const input = record(data);
      const action = memoryAction(input.action);
      const args = record(input.args);
      await authority.check();
      const memory = request.memory;
      if (!memory) throw new Error("Host memory is not authorized for this run");
      try {
        return await memory({ action, args, signal });
      } finally {
        // A pause or lease revoke during the awaited read must not return a late result.
        await authority.check();
      }
    };
    const handle = async (message: JsonRecord): Promise<unknown> => {
      switch (message.operation) {
        case "agents":
          return agentBridge.invoke(message.data);
        case "agents_cancel":
          agentBridge.cancel(message.data);
          return {};
        case "tool": {
          const input = record(message.data);
          if (
            tools.catalog.some(
              (tool) => tool.handle === input.handle && tool.argumentKind === "run_subagent",
            )
          )
            throw new Error("Delegation requires the native agents provider");
          return tools.invoke(message.data);
        }
        case "model":
          return broker.stream(message.data, bridge!);
        case "model_cancel":
          broker.cancel(message.data);
          return {};
        case "memory":
          return serveMemory(message.data);
        case "boundary":
          return boundary("before_model");
        case "checkpoint": {
          // Save is deliberately allowed after the pause latch, but remains backend-fenced.
          signal.throwIfAborted();
          if (execution) {
            await execution.emit({
              type: "checkpoint",
              checkpoint: { session: message.data, placement: request.placement },
            });
          } else {
            if (authority.paused) await agents.service.suspend();
            authority.rootState = {
              ...authority.rootState,
              ...record(message.data),
              rootParticipantId: request.runId,
              agents: agents.service.snapshot(),
              pause: authority.gracefulPause ? { queue: "paused" } : undefined,
              runtimeExecutionEvidence: [
                ...(authority.paused && Array.isArray(authority.rootState?.runtimeExecutionEvidence)
                  ? authority.rootState.runtimeExecutionEvidence
                  : []),
                ...tools.pendingPauseEvents,
                ...deferredChildEvents,
              ]
                .filter((event) => event.type === "execution")
                .slice(-200),
            };
            await agents.persist(true);
          }
          if (authority.paused) {
            await boundary("paused");
            tools.publishPause();
            if (!execution) {
              for (const event of deferredChildEvents.splice(0)) emit(event);
            }
          }
          return { saved: true };
        }
        default:
          throw new Error("Unsupported managed bridge operation");
      }
    };
    const disconnect = (cause?: unknown) =>
      rejectSettled(new Error("Isolated Pi disconnected before durable completion", { cause }));
    let abortWork: Promise<unknown> | undefined;
    const abort = () => {
      broker.stop();
      abortWork ??= (
        bridge?.request("shutdown", {}, AbortSignal.timeout(2000)) ?? Promise.resolve()
      )
        .catch(() => undefined)
        .finally(() => rejectSettled(new Error("Managed Pi aborted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      bridge = new JsonPeer(connection.bridge, handle, (event) => {
        if (event.type === "disconnected") disconnect(event.cause);
        if (event.type === "worker_error") rejectSettled(new Error("Managed queued prompt failed"));
        if (event.type === "hello" && event.version === 1 && event.runtimeVersion === "0.85.1") {
          clearTimeout(helloTimer);
          resolveHello();
        }
        if (
          event.type === "kit_activity" &&
          ["compaction", "retry", "queue"].includes(String(event.activity)) &&
          ["started", "completed", "paused"].includes(String(event.status))
        ) {
          const state = record(event.state ?? {});
          if (
            event.activity === "queue" &&
            state.kind === "execution" &&
            typeof state.toolCallId === "string" &&
            typeof state.name === "string"
          ) {
            const input = record(state.input ?? {});
            const detail =
              state.details && typeof state.details === "object" && !Array.isArray(state.details)
                ? record(state.details)
                : {};
            const evidence = boundedExecutionEvidence({
              parentExecutionId: state.parentExecutionId ?? detail.parentExecutionId,
              operationAddress: state.operationAddress ?? detail.operationAddress,
              code: input.code,
              source: state.source ?? detail.source,
              input: state.input,
              output: state.content,
              details: state.details,
              ...fabricNestedCallEvidence(state.nestedCalls ?? detail.nestedCalls ?? detail),
            });
            const execution: AgentRuntimeEvent = {
              ...evidence.value,
              type: "execution",
              executionId: `${request.runId}:${state.toolCallId}`,
              name: state.name,
              participantId: request.runId,
              status:
                state.isError === true
                  ? "failed"
                  : (event.status as "started" | "completed" | "paused"),
              truncated: evidence.truncated || state.truncated === true,
            };
            if (authority.paused) tools.pendingPauseEvents.push(execution);
            else emit(execution);
            if (state.name === "fabric_exec") {
              for (const child of nestedFabricExecutionEvents(
                execution.executionId,
                request.runId,
                evidence.value.nestedCalls,
                execution.status,
              )) {
                if (authority.paused) tools.pendingPauseEvents.push(child);
                else emit(child);
              }
            }
          } else
            emit({
              type: "runtime_activity",
              activity: event.activity as "compaction" | "retry" | "queue",
              status: event.status as "started" | "completed" | "paused",
              state: event.state,
            });
        }
      });
      rpc = new JsonPeer(
        connection.rpc,
        async () => {
          throw new Error("Unexpected RPC request");
        },
        (event) => {
          if (event.type === "disconnected") disconnect(event.cause);
          if (event.type === "message_end") {
            const message = record(event.message ?? {});
            if (message.role === "assistant" && message.stopReason === "error") {
              authority.paused = true;
              gateAbort.abort();
            }
          }
          if (event.type === "agent_settled") resolveSettled();
          if (event.type === "message_update") {
            const update = record(event.assistantMessageEvent);
            if (update.type === "text_delta" && typeof update.delta === "string") {
              text += update.delta;
              emit({ type: "text", text: update.delta });
            }
          }
          if (event.type === "compaction_start" || event.type === "compaction_end")
            emit({
              type: "progress",
              text: event.type === "compaction_start" ? "Compacting context" : "",
              activity: true,
            });
        },
        true,
      );
      if (signal.aborted) abort();
      await Promise.race([
        hello,
        settled.then(() => {
          throw new Error("Pi settled before readiness");
        }),
      ]);
      authority.workerBridges.set(request.runId, bridge);
      const initial = await boundary("before_model");
      const history = request.history.filter(
        (item) => !initial.messages.some((steering) => steering.messageId === item.id),
      );
      const ready = record(
        await bridge.request(
          "initialize",
          {
            version: 1,
            scope,
            placement: request.placement,
            instructions: request.instructions,
            history,
            initialMessageIds: initial.messages.map((item) => item.messageId),
            sourceMessageId: request.sourceMessageId,
            restore: request.session?.restore
              ? workerSessionCheckpoint(request.session.restore)
              : undefined,
            tools: tools.catalog.filter((tool) => tool.argumentKind !== "run_subagent"),
            agents: request.tools.some((tool) => tool.name === "run_subagent"),
            model: broker.metadata(),
            thinkingLevel: thinkingLevelFor(broker.model, request.model.thinkingLevel),
            memory: request.memory !== undefined,
          },
          signal,
        ),
      );
      if (ready.version !== 1 || ready.runtimeVersion !== "0.85.1" || ready.nativeTools !== false)
        throw new Error("Unsafe or incompatible Pi worker");
      if (request.memory && ready.memory !== true)
        throw new Error("Managed worker lacks host memory support");
      const previousSelection = ModelSelectionStatusSchema.safeParse(
        request.session?.restore ? record(request.session.restore).modelSelection : undefined,
      );
      await request.assertModelAllowed?.(request.model.provider, request.model.id);
      await applyManagedModelSelection({
        requested: {
          provider: request.model.provider,
          modelId: request.model.id,
          thinkingLevel: request.model.thinkingLevel ?? null,
        },
        thinkingLevel: thinkingLevelFor(broker.model, request.model.thinkingLevel),
        previous: previousSelection.success ? previousSelection.data.effective : null,
        established: Boolean(request.session?.restore || history.length),
        modelId: broker.model.id,
        rpc: (command, data) => rpc!.request(command, data, signal),
        checkpoint: async (status) => {
          await bridge!.request("model_selection", status, signal);
        },
      });
      bootstrapped = true;
      await boundary("idle");
      if (request.queueOnly && !rootPrompted) {
        if (!depth) {
          if (authority.paused) await agents.service.suspend();
          else await agents.service.drain();
          await dispatchWork;
        }
        await bridge.request("finish", {}, signal);
        await bridge.request("shutdown", {}, AbortSignal.timeout(2000));
        emit({ type: "done" });
        return;
      }
      // Prefix prevents a user's leading slash from invoking a privileged extension command.
      if (!request.queueOnly)
        await rpc.request(
          "prompt",
          {
            message: `User request:\n${request.prompt}${initial.messages.length ? "\n\nAdditional user context:\n" + initial.messages.map((item) => item.text).join("\n") : ""}`,
            images: [
              ...toPiImages(request.currentTurnImages),
              ...initial.messages.flatMap((item) => item.images),
            ],
          },
          signal,
        );
      await settled;
      if (!depth) {
        if (authority.paused) await agents.service.suspend();
        else await agents.service.drain();
        await dispatchWork;
      }
      await authority.chain;
      const settledBoundary = authority.paused ? undefined : await boundary("settled");
      const idle = authority.paused ? undefined : await boundary("idle");
      if (settledBoundary?.messages.length || idle?.messages.length)
        throw new Error("Idle queue delivery requires a new fenced run");
      await bridge.request(
        "finish",
        {
          compact: Boolean(settledBoundary?.compact || idle?.compact),
          state: idle?.state ?? settledBoundary?.state,
        },
        signal,
      );
      await bridge.request("shutdown", {}, AbortSignal.timeout(2000));
      if (!text.trim() && !authority.paused && !request.allowSilentEmpty) {
        text = request.emptyResponseText?.trim() || "No response. Try again.";
        emit({ type: "text", text });
      }
      emit(text ? { type: "done", text } : { type: "done" });
    } finally {
      gateAbort.abort();
      agentBridge.close();
      agents.bindings.delete(request.runId);
      authority.workerBridges.delete(request.runId);
      clearTimeout(helloTimer);
      signal.removeEventListener("abort", abort);
      broker.stop();
      await abortWork;
      try {
        await connection.stop();
      } finally {
        lifetime.abort();
        await Promise.all([bridge?.close(), rpc?.close()]);
      }
    }
  }
}
