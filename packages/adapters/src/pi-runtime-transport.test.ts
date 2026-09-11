import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  conversationSessionId,
  reliableStreamOptions,
  sessionGenerationFromId,
} from "./pi-runtime.js";

describe("Pi runtime transport", () => {
  it.each([
    { source: "provider", provider: "openai-codex", api: "openai-completions" },
    { source: "API", provider: "custom-provider", api: "openai-codex-responses" },
  ])("forces SSE when Codex is identified by $source", ({ provider, api }) => {
    const model = { provider, api } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto", maxRetries: 4 })).toEqual({
      transport: "sse",
      maxRetries: 4,
    });
  });

  it.each(["opencode", "opencode-go"])("attaches sticky affinity for %s", (provider) => {
    const model = { provider, api: "openai-completions" } as Model<Api>;
    const options = { sessionId: "thread:bot", headers: { "x-custom": "value" } };
    expect(reliableStreamOptions(model, options)).toMatchObject({
      sessionId: "thread:bot",
      headers: {
        "x-opencode-session": "thread:bot",
        "x-opencode-client": "rakazo",
        "x-custom": "value",
      },
    });
    expect(options.headers).toEqual({ "x-custom": "value" });
    const fallback = reliableStreamOptions(model);
    expect(fallback?.sessionId).toBeTruthy();
    expect(fallback?.headers?.["x-opencode-session"]).toBe(fallback?.sessionId);
  });

  it("isolates conversation and participant identities", () => {
    expect(conversationSessionId("thread", "bot")).toBe("thread:bot");
    expect(conversationSessionId("thread", "bot", "child")).toBe("thread:bot:child");
    expect(conversationSessionId("thread", "bot", undefined, 4)).toBe("thread:bot:g4");
    expect(conversationSessionId("thread", "bot", "child", 4)).toBe("thread:bot:g4:child");
    expect(conversationSessionId("other", "bot")).not.toBe(conversationSessionId("thread", "bot"));
    expect(conversationSessionId("thread", "other")).not.toBe(
      conversationSessionId("thread", "bot"),
    );
    expect(sessionGenerationFromId("thread:bot:g4", "thread", "bot")).toBe(4);
    expect(sessionGenerationFromId("thread:bot:g4:child", "thread", "bot")).toBe(4);
    expect(sessionGenerationFromId("thread:bot", "thread", "bot")).toBe(0);
    expect(sessionGenerationFromId("root-affinity", "thread", "bot")).toBe(0);
  });

  it("leaves other provider transports unchanged", () => {
    const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
    const options = { transport: "auto" as const, maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toBe(options);
  });
});
