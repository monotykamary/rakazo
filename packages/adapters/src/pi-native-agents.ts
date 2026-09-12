import type { AgentRunRequest, AgentRuntimeEvent, AgentSteeringMessage } from "@rakazo/adapter-kit";
import { ModelSelectionSchema } from "@rakazo/contracts";
import {
  type AgentExecutionRequest,
  type AgentExecutionResponse,
  type AgentPrepareRequest,
  AgentService,
  createAgentServiceHandler,
} from "pi-fabric/agents";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { restoreAgentSnapshot } from "./pi-agent-snapshot.js";
import { record } from "./pi-rpc-protocol.js";
import type { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import { conversationSessionId, sessionGenerationFromId } from "./pi-runtime.js";

type PreparedRequest = AgentRunRequest & { parentExecutionId?: string };

export class NativeAgents {
  readonly service: AgentService;
  // Execution bindings only. IDs, lineage, admission, results and lifecycle belong to Fabric.
  readonly bindings = new Map<string, { request: AgentRunRequest; tools: ToolBridge }>();
  pollRoot?: () => Promise<void>;
  private saves: Promise<unknown> = Promise.resolve();
  private readonly deliveries = new Map<string, AgentSteeringMessage>();
  constructor(
    readonly authority: RunAuthority,
    private readonly emit: (event: AgentRuntimeEvent) => void,
    drive: (
      request: AgentRunRequest,
      execution: AgentExecutionRequest,
      parentExecutionId?: string,
    ) => Promise<AgentExecutionResponse>,
  ) {
    const execute = (execution: AgentExecutionRequest) => {
      const binding = execution.binding as PreparedRequest;
      return drive(binding, execution, binding.parentExecutionId);
    };
    const snapshot = restoreAgentSnapshot(authority.rootState ?? {}, authority.request.runId);
    this.service = new AgentService({
      rootId: authority.request.runId,
      maxStarts: 8,
      maxDepth: 3,
      maxConcurrent: 4,
      snapshot,
      restorePolicy:
        snapshot && snapshot.rootId !== authority.request.runId ? "new-root" : "preserve",
      assertAuthority: (_callerId, phase) =>
        phase?.checkpoint ? authority.checkLease(false, true) : authority.check(),
      port: {
        prepare: (input) => this.prepare(input),
        execute,
        resume: execute,
        pause: async ({ id }) => {
          await this.bindings.get(id)?.tools.waitForIdle();
          const peer = authority.workerBridges.get(id);
          if (!peer) return; // Admission may still be waiting for isolated transport readiness.
          const result = record(await peer.request("suspend", {}, authority.signal));
          if (result.paused !== true) throw new Error("Worker suspension was not confirmed");
        },
        steer: async ({ id, message }) => {
          await this.control(id, "deliver", { id: crypto.randomUUID(), text: message });
        },
        followUp: async ({ id, message }) => {
          if (authority.request.enqueueParticipant) {
            await authority.request.enqueueParticipant({
              participantId: id,
              lane: "followUp",
              text: message,
            });
            return;
          }
          await this.control(id, "deliver", { id: crypto.randomUUID(), text: message });
        },
        compact: async ({ id, instructions }) => {
          const result = record(await this.control(id, "compact", { instructions }));
          if (result.outcome !== "completed")
            throw new Error("Runtime command completion was not confirmed");
        },
      },
      topology: authority.request.agentTopology
        ? {
            self: () => authority.request.agentTopology!.self(),
            sessions: () => authority.request.agentTopology!.sessions(),
            peers: () => authority.request.agentTopology!.peers(),
            deliver: ({ id, operation, message, signal }) =>
              authority.request.agentTopology!.deliver({ id, operation, message, signal }),
            create: authority.request.agentTopology.create
              ? (request) => authority.request.agentTopology!.create!({
                  name: request.name,
                  ...(request.instructions ? { instructions: request.instructions } : {}),
                  ...(request.task ? { task: request.task } : {}),
                  ...(request.signal ? { signal: request.signal } : {}),
                })
              : undefined,
            remove: authority.request.agentTopology.remove
              ? (request) => authority.request.agentTopology!.remove!({
                  id: request.id,
                  ...(request.name ? { name: request.name } : {}),
                  ...(request.signal ? { signal: request.signal } : {}),
                })
              : undefined,
            dispatch: authority.request.agentTopology.dispatch
              ? (request) =>
                  authority.request.agentTopology!.dispatch!({
                    task: request.request.task,
                    ...(request.request.name ? { name: request.request.name } : {}),
                    ...(request.request.cwd ? { cwd: request.request.cwd } : {}),
                    ...(request.request.tools ? { tools: request.request.tools } : {}),
                    ...(request.signal ? { signal: request.signal } : {}),
                  })
              : undefined,
          }
        : undefined,
      onEvent: async (event) => {
        await this.persist();
        const child = event.record;
        if (["running", "progress", "settled"].includes(event.type)) {
          const projected: AgentRuntimeEvent = {
            type: "subagent",
            agentId: child.id,
            name: child.name,
            task: child.task,
            status:
              child.status === "completed"
                ? "completed"
                : ["failed", "stopped", "timed_out"].includes(child.status)
                  ? "failed"
                  : "running",
            ...(event.type === "progress" ? { progress: child.text.slice(-800) } : {}),
            ...(child.status === "completed" ? { result: child.text.slice(0, 12000) } : {}),
          };
          if (authority.paused) authority.deferredEvents.push(projected);
          else this.emit(projected);
        }
      },
    });
    authority.onPause = () => {
      void this.service.suspend().catch(() => undefined);
    };
  }
  dispatcher(callerId: string) {
    return createAgentServiceHandler(this.service, callerId);
  }
  async deliver(id: string, message: AgentSteeringMessage) {
    const entry = this.entry(id);
    if (!entry) throw new Error("Participant is outside this session's authority");
    if (this.deliveries.has(id)) throw new Error("Participant delivery is already pending");
    this.deliveries.set(id, message);
    try {
      return await this.service.resume(entry.record.parentId, id, message.text);
    } finally {
      this.deliveries.delete(id);
    }
  }
  entry(id: string) {
    return this.service.snapshot().records.find((item) => item.record.id === id);
  }
  async persist(checkpoint = false) {
    const save = this.saves.then(async () => {
      // A child pause must not commit the root approval lease before the root
      // checkpoint has collected every settled child and deferred product event.
      if (this.authority.paused && !checkpoint) return;
      await this.authority.checkLease(false, checkpoint);
      if (this.authority.paused && !checkpoint) return;
      if (this.authority.rootState) {
        const { participants: _legacy, ...state } = this.authority.rootState;
        this.authority.rootState = {
          ...state,
          rootParticipantId: this.authority.request.runId,
          agents: this.service.snapshot(),
        };
        await this.authority.request.session?.save(this.authority.rootState);
      }
    });
    this.saves = save.catch(() => undefined);
    await save;
  }
  private async control(id: string, operation: string, data: Record<string, unknown>) {
    await this.authority.check();
    const peer = this.authority.workerBridges.get(id);
    if (!peer) throw new Error("Participant is not active");
    const result = await peer.request(operation, data, this.authority.signal);
    await this.authority.check();
    return result;
  }
  private async prepare(input: AgentPrepareRequest): Promise<PreparedRequest> {
    const { id, parentId, request: args, signal } = input;
    await this.authority.check();
    signal.throwIfAborted();
    const parent = this.bindings.get(parentId);
    if (!parent) throw new Error("Participant execution binding is unavailable");
    const request = parent.request;
    const permission = parent.tools.catalog.find((tool) => tool.argumentKind === "run_subagent");
    if (!permission) throw new Error("Delegation is outside this participant's tool scope");
    const authorization = record(
      await parent.tools.invoke({
        handle: permission.handle,
        callId: crypto.randomUUID(),
        args: {
          task: args.task,
          name: args.name,
          model: args.model,
          thinking: args.thinking,
          cwd: args.cwd,
        },
      }),
    );
    if (authorization.paused || authorization.isError)
      throw new Error("Agent authorization did not complete");
    const previous = this.entry(id)?.record.checkpoint;
    const saved = previous ? record(previous) : {};
    const delivery = this.deliveries.get(id);
    // Continuations resolve the authoritative durable binding, not an old guest selection.
    const explicit =
      input.generation === 1 && (args.model !== undefined || args.thinking !== undefined);
    if (explicit && !request.resolveParticipantModel)
      throw new Error("Worker model selection requires backend authorization");
    let model =
      request.resolveParticipantModel && !explicit
        ? await this.authority.serialize(() => request.resolveParticipantModel!(id))
        : undefined;
    if (explicit) {
      const current = model ?? request.model;
      const identity = args.model ?? `${current.provider}/${current.id}`;
      const separator = identity.indexOf("/");
      if (separator < 1 || identity.includes("://"))
        throw new Error("Worker model must use provider/model identity");
      const selection = ModelSelectionSchema.parse({
        provider: identity.slice(0, separator),
        modelId: identity.slice(separator + 1),
        thinkingLevel: args.thinking ?? current.thinkingLevel ?? null,
      });
      model = await this.authority.serialize(() => request.resolveParticipantModel!(id, selection));
    }
    let placement = request.placement;
    let executeTool = request.executeTool;
    const selectedPlacement =
      delivery?.placement ??
      (input.generation > 1 && saved.placement
        ? (saved.placement as AgentRunRequest["placement"])
        : args.cwd !== undefined
          ? { cwd: args.cwd }
          : undefined);
    if (selectedPlacement) {
      if (!request.authorizeSubagentPlacement)
        throw new Error("Explicit subagent placement requires backend authorization");
      const authorized = await this.authority.serialize(() =>
        request.authorizeSubagentPlacement!(selectedPlacement, id),
      );
      placement = authorized.placement;
      executeTool = authorized.executeTool;
    }
    let tools = request.tools.filter((tool) =>
      tool.name === "run_subagent"
        ? args.recursive !== false
        : tool.name !== "manage_queue" && !DELEGATION_TOOL_NAMES.has(tool.name),
    );
    if (args.tools) {
      const core: Record<string, string> = {
        read: "read_file",
        write: "write_file",
        edit: "edit_file",
        ls: "list_files",
        bash: "shell",
      };
      const allowed = new Set<AgentRunRequest["tools"][number]>();
      for (const requested of args.tools) {
        const name = requested.startsWith("pi.") ? requested.slice(3) : requested;
        if (["grep", "find", "powershell"].includes(name))
          throw new Error("Agent query-only tool scope requires a dedicated backend capability");
        const index = parent.tools.catalog.findIndex((tool) =>
          core[name]
            ? tool.name === core[name] && tool.argumentKind === core[name]
            : tool.name === requested.replace(/^extensions\./, "") &&
              ![
                "read_file",
                "write_file",
                "edit_file",
                "list_files",
                "shell",
                "run_subagent",
              ].includes(tool.argumentKind),
        );
        const selected = request.tools[index];
        if (!selected || !tools.includes(selected))
          throw new Error("Agent tool is outside parent scope");
        allowed.add(selected);
      }
      tools = tools.filter((tool) => tool.name === "run_subagent" || allowed.has(tool));
    }
    await this.authority.check();
    signal.throwIfAborted();
    return {
      ...request,
      runId: id,
      modelSessionId: conversationSessionId(
        request.threadId,
        request.botId,
        id,
        sessionGenerationFromId(request.modelSessionId, request.threadId, request.botId),
      ),
      prompt: args.task,
      model: model ?? request.model,
      parentExecutionId:
        typeof authorization.executionId === "string" ? authorization.executionId : undefined,
      modelRouting: model ? undefined : request.modelRouting,
      placement,
      executeTool,
      tools,
      instructions: `${request.instructions}\nComplete the delegated task. Participant depth: ${input.depth}. ${args.systemPrompt ?? ""}`,
      history: [],
      memory: undefined,
      queueOnly: false,
      sourceMessageId: delivery?.messageId ?? delivery?.id ?? request.sourceMessageId,
      currentTurnImages:
        delivery?.images ??
        args.images?.map((image, index) => {
          if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mimeType))
            throw new Error("Unsupported agent image type");
          return {
            name: `agent-image-${index + 1}`,
            data: Buffer.from(image.data, "base64"),
            mimeType: image.mimeType as "image/png",
          };
        }),
      session: saved.session ? { restore: saved.session, save: async () => undefined } : undefined,
      claimSteering: request.claimParticipantSteering
        ? (seen) => request.claimParticipantSteering!(id, seen)
        : undefined,
    };
  }
}
