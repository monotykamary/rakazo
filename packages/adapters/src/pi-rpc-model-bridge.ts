import type { Context } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ModelRoutingBroker } from "./model-routing-broker.js";
import { record, string } from "./pi-rpc-protocol.js";
import type { RunAuthority } from "./pi-rpc-tool-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";
import {
  billedPromptTokens,
  conversationSessionId,
  modelsForRequest,
  reliableStreamOptions,
} from "./pi-runtime.js";

export class ModelBridge {
  private readonly active = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly routing: ModelRoutingBroker;
  private readonly vision?: {
    model: AgentRunRequest["model"];
    models: ReturnType<typeof modelsForRequest>;
    resolved: NonNullable<ReturnType<ReturnType<typeof modelsForRequest>["getModel"]>>;
  };
  readonly models;
  readonly model;
  constructor(
    private readonly request: AgentRunRequest,
    private readonly authority: RunAuthority,
    private readonly emit: (event: AgentRuntimeEvent) => void,
  ) {
    this.routing = new ModelRoutingBroker(request);
    this.models = this.routing.primary.models;
    this.model = this.routing.primary.resolved;
    if (request.visionHandoff) {
      const models = modelsForRequest(
        { model: request.visionHandoff },
        request.visionHandoff.provider,
      );
      const resolved = models.getModel(request.visionHandoff.provider, request.visionHandoff.id);
      if (!resolved?.input.includes("image"))
        throw new Error("Vision handoff model is unavailable");
      this.vision = { model: request.visionHandoff, models, resolved };
    }
  }
  /** Intentionally omit endpoints, headers, auth and provider configuration from the child. */
  metadata() {
    const model = this.model;
    return {
      id: model.id,
      name: model.name,
      provider: "rakazo-broker",
      api: "openai-completions",
      baseUrl: "http://broker.invalid",
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      contextWindow: this.routing.contextWindow,
      maxTokens: this.routing.maxTokens,
      cost: model.cost,
    };
  }
  visionMetadata() {
    const vision = this.vision?.resolved;
    if (!vision) return undefined;
    return {
      id: vision.id,
      name: vision.name,
      provider: "rakazo-broker",
      api: "openai-completions",
      baseUrl: "http://broker.invalid",
      reasoning: vision.reasoning,
      thinkingLevelMap: vision.thinkingLevelMap,
      input: vision.input,
      contextWindow: vision.contextWindow,
      maxTokens: vision.maxTokens,
      cost: vision.cost,
    };
  }
  cancel(value: unknown) {
    this.active.get(string(record(value).streamId))?.abort();
  }
  async stream(value: unknown, peer: JsonPeer) {
    await this.authority.check();
    const input = record(value);
    const id = string(input.streamId);
    if (this.seen.has(id) || this.active.size >= 8)
      throw new Error("Invalid model stream identity");
    const context = record(input.context) as unknown as Context;
    if (!Array.isArray(context.messages)) throw new Error("Invalid model context");
    // Compaction may disable tools entirely; every tool-enabled stream is Fabric-only.
    if (
      context.tools !== undefined &&
      (!Array.isArray(context.tools) ||
        context.tools.length > 1 ||
        context.tools.some((tool) => record(tool).name !== "fabric_exec"))
    )
      throw new Error("Managed model tools must be exclusively fabric_exec");
    const supplied = record(input.options ?? {});
    const requested = input.model ? record(input.model) : undefined;
    this.seen.add(id);
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = AbortSignal.any([controller.signal, this.authority.signal]);
    try {
      if (
        this.vision &&
        requested?.provider === "rakazo-broker" &&
        requested.id === this.vision.resolved.id
      ) {
        await this.request.assertModelAllowed?.(this.vision.model.provider, this.vision.model.id);
        const vision = this.vision;
        const stream = vision.models.streamSimple(vision.resolved, context, {
          ...reliableStreamOptions(vision.resolved, {
            signal,
            sessionId:
              this.request.modelSessionId?.trim() ||
              conversationSessionId(this.request.threadId, this.request.botId),
            apiKey: vision.model.oauth
              ? undefined
              : (vision.model.apiKey ?? (vision.model.baseUrl ? "local" : undefined)),
            maxTokens:
              typeof supplied.maxTokens === "number"
                ? Math.max(1, Math.min(supplied.maxTokens, vision.resolved.maxTokens))
                : undefined,
          }),
          env: {},
        });
        for await (const event of stream) {
          await this.authority.check();
          if (event.type === "done" && event.message.usage) {
            this.emit({
              type: "usage",
              ...billedPromptTokens(event.message.usage),
              provider: vision.model.provider,
              model: vision.model.id,
            });
          }
          await peer.send({ type: "model_event", streamId: id, event });
        }
        return { complete: true };
      }
      const stream = this.routing.stream(
        context,
        supplied,
        signal,
        () => this.authority.check(),
        (target, status, usage) => {
          if (usage)
            this.emit({
              type: "usage",
              ...billedPromptTokens(usage),
              provider: target.provider,
              model: target.modelId,
            });
          if (this.request.modelRouting)
            this.emit({
              type: "runtime_activity",
              activity: "routing",
              status,
              state: { kind: "model-routing", ...target },
            });
        },
      );
      for await (const event of stream) {
        await this.authority.check();
        await peer.send({ type: "model_event", streamId: id, event });
      }
      return { complete: true };
    } finally {
      this.active.delete(id);
    }
  }
  stop() {
    for (const controller of this.active.values()) controller.abort();
  }
}
