import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ModelRoutingBroker, ModelRoutingCache } from "./model-routing-broker.js";

type Resolver = NonNullable<ConstructorParameters<typeof ModelRoutingBroker>[2]>;
type Target = Parameters<Resolver>[0];
const context: Context = { messages: [] };
const model = { provider: "provider-a", id: "model-a", apiKey: "fake-primary-key" };
function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "test",
    instructions: "test",
    history: [],
    tools: [],
    model,
    modelRouting: {
      key: "test-owner:space:preference",
      strategy: "ordered",
      pool: [
        { credentialId: "primary", model },
        { credentialId: "secondary", model: { ...model, apiKey: "fake-secondary-key" } },
      ],
      fallbacks: [
        {
          credentialId: "fallback",
          model: { provider: "provider-b", id: "model-b", apiKey: "fake-fallback-key" },
        },
      ],
    },
  };
}
function assistant(target: Target): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: target.model.provider,
    model: target.model.id,
    content: [],
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function fixture(
  plan: Record<string, "success" | "rate-limit" | "fatal" | "partial" | "thrown" | "empty"> = {},
) {
  const attempts: Array<{ credentialId: string; options: Record<string, unknown> }> = [];
  const resolve: Resolver = (target) => ({
    ...target,
    resolved: {
      ...target.model,
      name: target.model.id,
      api: "openai-completions",
      baseUrl: "http://unused.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: target.credentialId === "fallback" ? 4000 : 8000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    models: {
      streamSimple: (_model: unknown, _context: Context, options: Record<string, unknown>) =>
        (async function* (): AsyncGenerator<AssistantMessageEvent> {
          attempts.push({ credentialId: target.credentialId, options });
          const message = assistant(target);
          const behavior = plan[target.credentialId] ?? "success";
          if (behavior === "thrown") throw new Error("503 fake-provider-diagnostic");
          if (behavior === "empty") return;
          yield { type: "start", partial: message };
          if (behavior === "partial")
            yield { type: "text_delta", contentIndex: 0, delta: "visible", partial: message };
          if (["rate-limit", "fatal", "partial"].includes(behavior)) {
            yield {
              type: "error",
              reason: "error",
              error: {
                ...message,
                stopReason: "error",
                errorMessage: `${behavior === "fatal" ? "400" : "429"} fake-primary-key`,
              },
            };
          } else {
            yield { type: "done", reason: "stop", message };
          }
        })(),
    } as unknown as ReturnType<Resolver>["models"],
  });
  const cache = new ModelRoutingCache(() => 1000);
  const events = vi.fn();
  const run = async (input = request(), signal = new AbortController().signal) => {
    const broker = new ModelRoutingBroker(input, cache, resolve);
    const result: AssistantMessageEvent[] = [];
    for await (const event of broker.stream(context, {}, signal, async () => {}, events))
      result.push(event);
    return result;
  };
  return { attempts, resolve, cache, events, run };
}

describe("backend multiprovider routing", () => {
  it("uses the first ordered connection without trying other targets on success", async () => {
    const f = fixture();
    expect((await f.run()).at(-1)?.type).toBe("done");
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary"]);
    expect(f.attempts[0]!.options).toMatchObject({ apiKey: "fake-primary-key", env: {} });
  });
  it("reuses the scheduler for natural round-robin across requests", async () => {
    const f = fixture();
    const input = request();
    input.modelRouting!.strategy = "round-robin";
    await f.run(input);
    await f.run({ ...input, runId: "next-run" });
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary", "secondary"]);
    const service = f.cache.get(input.modelRouting!.key, "round-robin", input.modelRouting!.pool);
    expect(JSON.stringify(await service.snapshot())).not.toContain("fake-primary-key");
  });
  it("never shares selection state across principal/space routing identities", async () => {
    const f = fixture();
    const input = request();
    input.modelRouting!.strategy = "round-robin";
    await f.run(input);
    await f.run({
      ...input,
      modelRouting: { ...input.modelRouting!, key: "other-owner:space:preference" },
    });
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary", "primary"]);
  });
  it("rotates credentials before falling back to an explicitly different model", async () => {
    const f = fixture({ primary: "rate-limit", secondary: "rate-limit" });
    const result = await f.run();
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual([
      "primary",
      "secondary",
      "fallback",
    ]);
    expect(result.filter((event) => event.type === "start")).toHaveLength(1);
    const done = result.at(-1);
    expect(done?.type === "done" && done.message.model).toBe("model-b");
    expect(JSON.stringify(result)).not.toContain("fake-primary-key");
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ fallback: true, modelId: "model-b" }),
      "completed",
      expect.objectContaining({ input: 1, output: 1 }),
    );
    expect(f.events.mock.calls.filter((call) => call[2]).length).toBe(3);
  });
  it("never replays a request after visible output", async () => {
    const f = fixture({ primary: "partial" });
    const result = await f.run();
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary"]);
    expect(result.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(JSON.stringify(result)).not.toContain("fake-primary-key");
  });
  it("does not rotate a permanent request failure", async () => {
    const f = fixture({ primary: "fatal" });
    expect((await f.run()).at(-1)?.type).toBe("error");
    expect(f.attempts).toHaveLength(1);
  });
  it("handles transient thrown errors before output", async () => {
    const f = fixture({ primary: "thrown" });
    expect((await f.run()).at(-1)?.type).toBe("done");
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary", "secondary"]);
  });
  it("fails closed on an empty broken stream instead of silently succeeding", async () => {
    const f = fixture({ primary: "empty" });
    await expect(f.run()).rejects.toThrow("Configured model request failed");
    expect(f.attempts).toHaveLength(1);
  });
  it("stops before another provider call when cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.run(request(), controller.signal)).rejects.toThrow();
    expect(f.attempts).toHaveLength(0);
  });
  it("ends with one sanitized error after every allowed target fails", async () => {
    const f = fixture({ primary: "rate-limit", secondary: "rate-limit", fallback: "rate-limit" });
    const result = await f.run();
    expect(result.at(-1)?.type).toBe("error");
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual([
      "primary",
      "secondary",
      "fallback",
    ]);
    expect(f.events.mock.calls.filter((call) => call[2]).length).toBe(3);
    expect(JSON.stringify(result)).not.toContain("fake-primary-key");
  });
  it("does not send image context to a fallback without image capability", async () => {
    const f = fixture({ primary: "rate-limit", secondary: "rate-limit" });
    const resolve: Resolver = (target) => {
      const result = f.resolve(target);
      if (target.credentialId !== "fallback") result.resolved.input = ["text", "image"];
      return result;
    };
    const broker = new ModelRoutingBroker(request(), f.cache, resolve);
    const images: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "fake", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
    };
    const consume = async () => {
      for await (const _event of broker.stream(
        images,
        {},
        new AbortController().signal,
        async () => {},
        f.events,
      )) {
        /* Consume the stream. */
      }
    };
    await expect(consume()).rejects.toThrow("No configured model connection");
    expect(f.attempts.map((attempt) => attempt.credentialId)).toEqual(["primary", "secondary"]);
  });
  it("uses the smallest configured context and rejects a mixed-model pool", () => {
    const f = fixture();
    expect(new ModelRoutingBroker(request(), f.cache, f.resolve).contextWindow).toBe(4000);
    const input = request();
    input.modelRouting!.pool[1]!.model = { ...model, id: "other-model" };
    expect(() => new ModelRoutingBroker(input, f.cache, f.resolve)).toThrow(
      "preserve provider and model identity",
    );
  });
});
