import { createServer } from "node:http";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { ModelRoutingBroker } from "./model-routing-broker.js";

it("routes real SDK streams through approved accounts and an explicit fallback model", async () => {
  const calls: Array<{ key: string; model: string }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as { model: string };
    const key = request.headers.authorization ?? "";
    calls.push({ key, model: input.model });
    if (key !== "Bearer fake-fallback-key") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "429 test rate limit" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    chunk({ role: "assistant", content: "Fallback answer." }, null);
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Emulator unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const model = {
      provider: "openai-compatible",
      id: "model-a",
      baseUrl,
      apiKey: "fake-primary-key",
    };
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "offline-routing-run",
      prompt: "test",
      instructions: "test",
      history: [],
      tools: [],
      model,
      modelRouting: {
        key: `offline:${address.port}`,
        strategy: "ordered",
        pool: [
          { credentialId: "primary", model },
          { credentialId: "secondary", model: { ...model, apiKey: "fake-secondary-key" } },
        ],
        fallbacks: [
          {
            credentialId: "fallback",
            model: { ...model, id: "model-b", apiKey: "fake-fallback-key" },
          },
        ],
      },
    };
    const events: AssistantMessageEvent[] = [];
    for await (const event of new ModelRoutingBroker(request).stream(
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      {},
      AbortSignal.timeout(15_000),
      async () => {},
      () => {},
    ))
      events.push(event);
    expect(calls).toEqual([
      { key: "Bearer fake-primary-key", model: "model-a" },
      { key: "Bearer fake-secondary-key", model: "model-a" },
      { key: "Bearer fake-fallback-key", model: "model-b" },
    ]);
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(events)).toContain("Fallback answer.");
    expect(JSON.stringify(events)).not.toContain("fake-primary-key");
    expect(JSON.stringify(events)).not.toContain("fake-fallback-key");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
