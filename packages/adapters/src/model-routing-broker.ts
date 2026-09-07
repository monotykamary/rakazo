import type { AssistantMessageEvent, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { MultiProviderService, NoAccountAvailableError } from "pi-multiprovider";
import { modelsForRequest, reliableStreamOptions } from "./pi-runtime.js";

type Target = { credentialId: string; model: AgentRunRequest["model"] };
function resolveTarget(target: Target) {
  const models = modelsForRequest(target, target.model.provider);
  const model = models.getModel(target.model.provider, target.model.id);
  if (!model) throw new Error("The configured routing model is unavailable");
  return { ...target, models, resolved: model };
}
type ResolvedTarget = ReturnType<typeof resolveTarget>;

/** Bounded scheduler state stores only opaque credential references, never credentials. */
export class ModelRoutingCache {
  private readonly entries = new Map<string, { service: MultiProviderService; touched: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  get(key: string, strategy: "ordered" | "round-robin", targets: Target[]): MultiProviderService {
    const identity = JSON.stringify([
      key,
      strategy,
      targets.map(({ credentialId, model }) => [credentialId, model.provider, model.id]),
    ]);
    const now = this.now();
    for (const [id, entry] of this.entries)
      if (now - entry.touched > 30 * 60_000) this.entries.delete(id);
    const existing = this.entries.get(identity);
    if (existing) {
      existing.touched = now;
      return existing.service;
    }
    if (this.entries.size >= 256) {
      const oldest = [...this.entries].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const service = new MultiProviderService({
      defaultPolicy: strategy === "ordered" ? "priority" : "round-robin",
      affinity: false,
      now: this.now,
    });
    const references = targets.map(({ credentialId }, index) => ({
      id: String(index).padStart(3, "0"),
      label: "Connection",
      authKind: "custom" as const,
      credentialRef: credentialId,
      priority: index,
    }));
    service.registerProvider({ id: "pool", label: "Connections", accounts: () => references });
    this.entries.set(identity, { service, touched: now });
    return service;
  }
}
const routingCache = new ModelRoutingCache();

export class ModelRoutingBroker {
  readonly primary: ResolvedTarget;
  readonly contextWindow: number;
  readonly maxTokens: number;
  private readonly pool: ResolvedTarget[];
  private readonly fallbacks: ResolvedTarget[];
  private readonly service: MultiProviderService;
  private readonly assertModelAllowed: AgentRunRequest["assertModelAllowed"];
  constructor(request: AgentRunRequest, cache = routingCache, resolve = resolveTarget) {
    this.assertModelAllowed = request.assertModelAllowed;
    const routing = request.modelRouting;
    const targets = routing?.pool ?? [{ credentialId: "primary", model: request.model }];
    if (!targets.length || targets.length > 20 || (routing?.fallbacks.length ?? 0) > 20)
      throw new Error("Invalid model routing pool");
    if (
      targets.some(
        (target) =>
          target.model.provider !== request.model.provider || target.model.id !== request.model.id,
      )
    )
      throw new Error("Routing pool must preserve provider and model identity");
    if (new Set(targets.map((target) => target.credentialId)).size !== targets.length)
      throw new Error("Duplicate routing connection");
    this.pool = targets.map(resolve);
    this.fallbacks = (routing?.fallbacks ?? []).map(resolve);
    this.primary = this.pool[0]!;
    this.contextWindow = Math.min(
      ...[...this.pool, ...this.fallbacks].map((target) => target.resolved.contextWindow),
    );
    this.maxTokens = Math.min(
      ...[...this.pool, ...this.fallbacks].map((target) => target.resolved.maxTokens),
    );
    // Unconfigured runs use an isolated scheduler; they never share a synthetic account identity.
    this.service = (routing ? cache : new ModelRoutingCache()).get(
      routing?.key ?? request.runId,
      routing?.strategy ?? "ordered",
      targets,
    );
  }

  async *stream(
    context: Context,
    supplied: Record<string, unknown>,
    signal: AbortSignal,
    beforeAttempt: () => Promise<void>,
    onAttempt: (
      target: { credentialId: string; provider: string; modelId: string; fallback: boolean },
      status: "started" | "completed" | "failed",
      usage?: { input: number; output: number },
    ) => void,
  ): AsyncGenerator<AssistantMessageEvent> {
    const excluded = new Set<string>();
    let fallbackIndex = 0;
    while (true) {
      signal.throwIfAborted();
      await beforeAttempt();
      let lease: Awaited<ReturnType<MultiProviderService["acquire"]>> | undefined;
      let target: ResolvedTarget;
      let fallback = false;
      try {
        lease = await this.service.acquire<string>({
          providerId: "pool",
          excludeAccountIds: excluded,
        });
        excluded.add(lease.accountId);
        target = this.pool.find((entry) => entry.credentialId === lease!.credentialRef)!;
      } catch (error) {
        if (!(error instanceof NoAccountAvailableError)) throw error;
        // Cooling accounts are unavailable, not permission to repeat them. Explicit fallbacks remain eligible.
        const next = this.fallbacks[fallbackIndex++];
        if (!next) throw new Error("No configured model connection is currently available");
        target = next;
        fallback = true;
      }
      // Permission changes are not provider outages: never retry or fall back around them.
      try {
        await this.assertModelAllowed?.(target.model.provider, target.model.id);
      } catch (error) {
        lease?.release({ status: "cancelled" });
        throw error;
      }
      const attempt = {
        credentialId: target.credentialId,
        provider: target.model.provider,
        modelId: target.model.id,
        fallback,
      };
      const model = target.resolved;
      const hasImages = context.messages.some(
        (message) =>
          Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
      );
      if (hasImages && !model.input.includes("image")) {
        lease?.release({ status: "cancelled" });
        continue;
      }
      const options: SimpleStreamOptions = {
        signal,
        apiKey: target.model.oauth
          ? undefined
          : (target.model.apiKey ?? (target.model.baseUrl ? "local" : undefined)),
        maxTokens:
          typeof supplied.maxTokens === "number"
            ? Math.max(1, Math.min(supplied.maxTokens, this.maxTokens))
            : undefined,
        temperature:
          typeof supplied.temperature === "number"
            ? Math.max(0, Math.min(2, supplied.temperature))
            : undefined,
        reasoning:
          target.model.thinkingLevel === "off" || !model.reasoning
            ? undefined
            : (target.model.thinkingLevel ?? "medium"),
      };
      let outputStarted = false;
      let retryable = false;
      let failure: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
      let start: AssistantMessageEvent | undefined;
      let succeeded = false;
      let failureReported = false;
      let usage: { input: number; output: number } | undefined;
      try {
        onAttempt(attempt, "started");
        const stream = target.models.streamSimple(model, context, {
          ...reliableStreamOptions(model, options),
          env: {},
        });
        for await (const event of stream) {
          signal.throwIfAborted();
          await beforeAttempt();
          if (event.type === "start" && !outputStarted) {
            start = event;
            continue;
          }
          if (event.type === "error") {
            failure = event;
            usage = event.error.usage;
            const disposition = lease?.release({
              status: "failure",
              error: { message: event.error.errorMessage ?? "Model request failed", outputStarted },
            });
            // Fallbacks use the same upstream classifier without joining the same-model account pool.
            retryable =
              disposition?.retryable ??
              (await this.classifyFallbackFailure(
                target,
                event.error.errorMessage ?? "Model request failed",
                outputStarted,
              ));
            break;
          }
          outputStarted = true;
          if (start) {
            yield start;
            start = undefined;
          }
          yield event;
          if (event.type === "done") {
            succeeded = true;
            usage = event.message.usage;
            break;
          }
        }
        if (succeeded) {
          lease?.release({ status: "success" });
          onAttempt(attempt, "completed", usage);
          return;
        }
        onAttempt(attempt, "failed", usage);
        failureReported = true;
        if (!failure) throw new Error("Configured model stream ended unexpectedly");
        if (
          outputStarted ||
          !retryable ||
          (excluded.size >= this.pool.length && fallbackIndex >= this.fallbacks.length)
        ) {
          if (start) yield start;
          yield {
            ...failure,
            error: { ...failure.error, errorMessage: "Configured model request failed" },
          };
          return;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!failureReported) onAttempt(attempt, "failed", usage);
        const message = error instanceof Error ? error.message : "Model request failed";
        const disposition = lease?.release({
          status: "failure",
          error: { message, outputStarted },
        });
        const retry =
          disposition?.retryable ??
          (await this.classifyFallbackFailure(target, message, outputStarted));
        if (outputStarted || !retry) throw new Error("Configured model request failed");
      } finally {
        lease?.release({ status: "cancelled" });
      }
    }
  }

  private async classifyFallbackFailure(
    target: ResolvedTarget,
    message: string,
    outputStarted: boolean,
  ): Promise<boolean> {
    // Reuse the package's neutral classifier; fallbacks never join the same-model account pool.
    const service = new MultiProviderService();
    service.registerProvider({
      id: "fallback",
      label: "Fallback",
      accounts: () => [
        {
          id: target.credentialId,
          label: "Connection",
          authKind: "custom",
          credentialRef: target.credentialId,
        },
      ],
    });
    const lease = await service.acquire({ providerId: "fallback" });
    return (
      lease.release({ status: "failure", error: { message, outputStarted } })?.retryable === true
    );
  }
}
