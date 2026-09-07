import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSteeringMessage,
} from "@rakazo/adapter-kit";
import {
  ModelSelectionSchema,
  ModelSelectionStatusSchema,
  QueueControlCommandSchema,
  type QueueControlResult,
} from "@rakazo/contracts";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { boundedExecutionEvidence } from "./pi-execution-evidence.js";
import { applyManagedModelSelection } from "./pi-model-handoff.js";
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
      authority.rootState = { ...restored, rootParticipantId: request.runId };
      for (const [id, value] of Object.entries(record(restored.participants ?? {}))) {
        const participant = record(value);
        authority.childSessions.set(id, {
          ...participant,
          parentParticipantId:
            participant.parentParticipantId === restored.rootParticipantId
              ? request.runId
              : participant.parentParticipantId,
        });
      }
    }
    const work = this.execute(frozen, context, authority, (event) => queue.push(event))
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
    depth = 0,
    activeChildren = new Map<string, Promise<void>>(),
    pollRoot?: () => Promise<void>,
  ): Promise<void> {
    const signal = authority.signal;
    await authority.check();
    const scope = Object.freeze({
      runId: request.runId,
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
    const deferredChildEvents: AgentRuntimeEvent[] = [];
    const persistParticipants = async () => {
      if (authority.rootState && !authority.paused)
        await authority.request.session?.save({
          ...authority.rootState,
          participants: Object.fromEntries(authority.childSessions),
        });
    };
    const delegate = async (
      args: Record<string, unknown>,
      agentId: string,
      delivery?: AgentSteeringMessage,
    ): Promise<unknown> => {
      if (!request.tools.some((tool) => tool.name === "run_subagent"))
        throw new Error("Delegation is outside this participant's tool scope");
      if (args.worktree === true)
        return {
          error:
            "Automatic worktree creation is unavailable. Create it through the authorized shell tool, then delegate with its workspace-relative cwd.",
        };
      if (depth >= 3 || authority.childrenStarted >= 8)
        throw new Error("Shared recursive subagent budget exceeded");
      await authority.check();
      const target = typeof args.participantId === "string" ? args.participantId : undefined;
      let previous = target ? record(authority.childSessions.get(target) ?? {}) : undefined;
      if (previous && previous.parentParticipantId !== request.runId)
        throw new Error("Participant is outside this parent's authority");
      if (target && authority.participants.has(target))
        throw new Error("Participant is already active; use targeted steering");
      const childId = target ?? `${authority.request.runId}-participant-${randomUUID()}`;
      const requestedPlacement =
        args.cwd !== undefined || args.worktreeId !== undefined
          ? {
              cwd: args.cwd as string | undefined,
              worktreeId: args.worktreeId as string | undefined,
            }
          : (previous?.placement as AgentRunRequest["placement"]);
      const explicitSelection = args.model !== undefined || args.thinking !== undefined;
      if (explicitSelection && !request.resolveParticipantModel)
        throw new Error("Worker model selection requires backend authorization");
      let childModel =
        request.resolveParticipantModel && args.model === undefined
          ? await authority.serialize(() => request.resolveParticipantModel!(childId))
          : undefined;
      if (explicitSelection) {
        const current = childModel ?? request.model;
        const model =
          typeof args.model === "string" ? args.model : `${current.provider}/${current.id}`;
        const separator = model.indexOf("/");
        if (separator < 1) throw new Error("Worker model must use provider/model identity");
        const selected = ModelSelectionSchema.parse({
          provider: model.slice(0, separator),
          modelId: model.slice(separator + 1),
          thinkingLevel: args.thinking ?? current.thinkingLevel ?? null,
        });
        childModel = await authority.serialize(() =>
          request.resolveParticipantModel!(childId, selected),
        );
      }
      let placement = request.placement;
      let executeTool = request.executeTool;
      if (requestedPlacement) {
        if (!request.authorizeSubagentPlacement)
          throw new Error("Explicit subagent placement requires backend authorization");
        const authorized = await authority.serialize(() =>
          request.authorizeSubagentPlacement!(requestedPlacement, childId),
        );
        placement = authorized.placement;
        executeTool = authorized.executeTool;
      }
      await authority.check();
      // Admission is atomic after authorization: no await between recheck and reservation.
      signal.throwIfAborted();
      if (authority.paused) throw new Error("Managed run is paused");
      previous = target ? record(authority.childSessions.get(target) ?? {}) : undefined;
      if (previous && previous.parentParticipantId !== request.runId)
        throw new Error("Participant is outside this parent's authority");
      if (activeChildren.has(childId) || authority.participants.has(childId))
        throw new Error("Participant is already active; use targeted steering");
      if (authority.childrenStarted >= 8)
        throw new Error("Shared recursive subagent budget exceeded");
      let resolveChild!: () => void;
      let rejectChild!: (error: unknown) => void;
      let childFailure: unknown;
      const childCompletion = new Promise<void>((resolve, reject) => {
        resolveChild = resolve;
        rejectChild = reject;
      });
      void childCompletion.catch(() => undefined);
      activeChildren.set(childId, childCompletion);
      // Started attempts consume the run-wide budget even if persistence or startup fails.
      authority.childrenStarted++;
      const name = String(args.name ?? previous?.name ?? "helper").slice(0, 80);
      const task = String(args.task ?? "");
      let result = "";
      authority.childSessions.set(childId, {
        ...previous,
        participantId: childId,
        parentParticipantId: request.runId,
        executionId: agentId,
        name,
        task,
        placement,
        status: "running",
      });
      try {
        await persistParticipants();
        emit({ type: "subagent", agentId: childId, name, task, status: "running" });
        await this.execute(
          {
            ...request,
            runId: childId,
            model: childModel ?? request.model,
            modelRouting: childModel ? undefined : request.modelRouting,
            prompt: task,
            sourceMessageId: delivery?.messageId ?? delivery?.id ?? request.sourceMessageId,
            currentTurnImages: delivery?.images,
            placement,
            executeTool,
            instructions: `${request.instructions}\nComplete the delegated task. Participant depth: ${depth + 1}. ${String(args.instructions ?? "")}`,
            history: [],
            tools: request.tools.filter(
              (tool) =>
                tool.name === "run_subagent" ||
                (tool.name !== "manage_queue" && !DELEGATION_TOOL_NAMES.has(tool.name)),
            ),
            session: previous?.session
              ? { restore: previous.session, save: async () => undefined }
              : undefined,
            claimSteering: request.claimParticipantSteering
              ? (seen) => request.claimParticipantSteering!(childId, seen)
              : undefined,
            runtimeBoundary: request.runtimeBoundary,
            // Least authority: delegated children never inherit host memory.
            memory: undefined,
            queueOnly: false,
          },
          context,
          authority,
          (event) => {
            if (event.type === "text") {
              result += event.text;
              emit({
                type: "subagent",
                agentId: childId,
                name,
                task,
                status: "running",
                progress: result.slice(-800),
              });
            } else if (event.type !== "done") {
              const childEvent =
                event.type === "execution"
                  ? { ...event, parentExecutionId: event.parentExecutionId ?? agentId }
                  : event;
              if (authority.paused) deferredChildEvents.push(childEvent);
              else emit(childEvent);
            }
          },
          depth + 1,
          activeChildren,
          pollRoot ?? pollFromChild,
        );
        authority.childSessions.set(childId, {
          ...record(authority.childSessions.get(childId)),
          status: authority.paused ? "paused" : "completed",
          result: result.slice(0, 12000),
        });
        await persistParticipants();
        if (!authority.paused)
          emit({
            type: "subagent",
            agentId: childId,
            name,
            task,
            status: "completed",
            result: result.slice(0, 12000),
          });
        return {
          participantId: childId,
          status: authority.paused ? "paused" : "completed",
          result: result.slice(0, 12000),
        };
      } catch (error) {
        childFailure = error;
        authority.childSessions.set(childId, {
          ...record(authority.childSessions.get(childId)),
          status: "failed",
        });
        await persistParticipants();
        emit({ type: "subagent", agentId: childId, name, task, status: "failed" });
        throw error;
      } finally {
        activeChildren.delete(childId);
        if (childFailure || authority.paused)
          rejectChild(childFailure ?? new Error("Participant paused"));
        else resolveChild();
      }
    };
    const tools = new ToolBridge(request, authority, emit, delegate);
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
        const participant = record(authority.childSessions.get(target) ?? {});
        if (
          participant.participantId !== target ||
          typeof participant.parentParticipantId !== "string"
        )
          return false;
        target = participant.parentParticipantId;
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
              if (message.placement) {
                if (!request.authorizeSubagentPlacement)
                  throw new Error("Queued placement authorization is unavailable");
                const authorized = await authority.serialize(() =>
                  request.authorizeSubagentPlacement!(message.placement!, target),
                );
                if (target === request.runId) {
                  request.executeTool = authorized.executeTool;
                  request.placement = authorized.placement;
                } else if (authority.participants.has(target))
                  throw new Error("Cannot replace a live child placement");
              }
              const targetPeer = authority.participants.get(target);
              if (!targetPeer) {
                const participant = record(authority.childSessions.get(target) ?? {});
                await delegate(
                  { participantId: target, name: participant.name, task: message.text },
                  `${request.runId}:queued:${message.id}`,
                  message,
                );
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
                const completion = activeChildren.get(target);
                if (completion) {
                  // Keep the backend reservation pending but release the worker boundary to make progress.
                  parkDispatch?.();
                  try {
                    await new Promise<void>((resolve, reject) => {
                      const abort = () => {
                        cleanup();
                        reject(commandSignal.reason);
                      };
                      const cleanup = () => commandSignal.removeEventListener("abort", abort);
                      commandSignal.addEventListener("abort", abort, { once: true });
                      if (commandSignal.aborted) {
                        abort();
                        return;
                      }
                      void completion.then(
                        () => {
                          cleanup();
                          resolve();
                        },
                        (error) => {
                          cleanup();
                          reject(error);
                        },
                      );
                    });
                  } catch {
                    commandSignal.throwIfAborted();
                    return { outcome: "rejected", error: "Participant did not complete" };
                  }
                }
                await authority.check();
                commandSignal.throwIfAborted();
                return record(authority.childSessions.get(target)).status === "completed"
                  ? { outcome: "completed" }
                  : { outcome: "rejected", error: "Participant requires resume or reconciliation" };
              }
              const peer = authority.participants.get(target);
              if (!peer) return { outcome: "rejected", error: "Participant is not active" };
              commandSignal.throwIfAborted();
              try {
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
    const boundary = async (name: "before_model" | "settled" | "idle" | "paused") => {
      if (name !== "paused") await authority.check();
      if (pollRoot && bootstrapped && name === "before_model") await pollRoot();
      const dispatched = pollRoot ? undefined : await dispatchBoundary(name);
      const result = pollRoot ? undefined : mergeBoundaryResults(pendingRootResult, dispatched);
      if (!pollRoot) pendingRootResult = undefined;
      const steering =
        name === "before_model" ? ((await request.claimSteering?.([...seen])) ?? []) : [];
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
        case "tool":
          return tools.invoke(message.data);
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
          if (depth) {
            const participant = record(authority.childSessions.get(request.runId));
            authority.childSessions.set(request.runId, { ...participant, session: message.data });
            await persistParticipants();
          } else {
            authority.rootState = {
              ...record(message.data),
              rootParticipantId: request.runId,
              participants: Object.fromEntries(authority.childSessions),
              runtimeExecutionEvidence: [
                ...tools.pendingPauseEvents,
                ...deferredChildEvents,
              ].filter((event) => event.type === "execution"),
            };
            await request.session?.save(authority.rootState);
          }
          if (authority.paused) {
            await boundary("paused");
            tools.publishPause();
            for (const event of deferredChildEvents.splice(0)) emit(event);
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
              nestedCalls: state.nestedCalls ?? detail.nestedCalls,
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
      authority.participants.set(request.runId, bridge);
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
            restore: request.session?.restore,
            tools: tools.catalog,
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
          await Promise.all(activeChildren.values());
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
        await Promise.all(activeChildren.values());
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
      authority.participants.delete(request.runId);
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
