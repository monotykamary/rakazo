import type { Context } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ModelRoutingBroker } from "./model-routing-broker.js";
import { record, string } from "./pi-rpc-protocol.js";
import type { RunAuthority } from "./pi-rpc-tool-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

export class ModelBridge {
  private readonly active = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly routing: ModelRoutingBroker;
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
    const supplied = record(input.options ?? {});
    this.seen.add(id);
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = AbortSignal.any([controller.signal, this.authority.signal]);
    try {
      const stream = this.routing.stream(
        context,
        supplied,
        signal,
        () => this.authority.check(),
        (target, status, usage) => {
          if (usage)
            this.emit({
              type: "usage",
              inputTokens: usage.input,
              outputTokens: usage.output,
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
