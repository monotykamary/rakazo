import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { toPiImages } from "./pi-runtime.js";
import { deliverPremoveDrain } from "./premove-drain.js";

// Only inference is synthetic: stock Pi owns prompt parsing, steering, tools and transcript.
it.each([false, true])(
  "stock Pi consumes one FIFO drain with every image (working=%s)",
  async (working) => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-drain-stock-"));
    const settingsManager = SettingsManager.inMemory({
      packages: [],
      extensions: [],
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    models.registerProvider("drain-offline", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "offline-fixture",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 32000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await models.refresh({ providers: ["drain-offline"], allowNetwork: false });
    const model = models.getModel("drain-offline", "fixture")!;
    const contexts: Context[] = [];
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let startedTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      startedTool = resolve;
    });
    let toolFinished = false;
    models.streamSimple = (_model, context) => {
      contexts.push({ ...context, messages: structuredClone(context.messages) });
      const useTool = working && contexts.length === 1;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 1,
        content: useTool
          ? [{ type: "toolCall", id: "safe-tool", name: "hold", arguments: {} }]
          : [{ type: "text", text: "done" }],
        stopReason: useTool ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    };
    const forbidden = () => {
      throw new Error("No external inference allowed");
    };
    models.stream = forbidden;
    models.complete = forbidden;
    models.completeSimple = forbidden;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: models,
      model,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
      noTools: "builtin",
      tools: ["hold"],
      customTools: [
        {
          name: "hold",
          label: "hold",
          description: "Offline safe-boundary probe",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            startedTool();
            await toolGate;
            expect(signal?.aborted).not.toBe(true);
            toolFinished = true;
            return { content: [{ type: "text", text: "tool finished" }], details: {} };
          },
        },
      ],
    });
    try {
      const running = working ? session.prompt("initial") : undefined;
      if (working)
        await Promise.race([
          toolStarted,
          running!.then(() => {
            throw new Error(JSON.stringify(session.messages));
          }),
        ]);
      const images = [1, 2, 3].map((value) => ({
        name: `image-${value}`,
        mimeType: "image/png" as const,
        data: new Uint8Array([value]),
      }));
      await deliverPremoveDrain(
        [
          { id: "first", messageId: "first", text: "first", images: images.slice(0, 2) },
          { id: "second", messageId: "second", text: "second", images: images.slice(2) },
        ],
        "stock",
        {
          deliver: (message) =>
            session.prompt(message.text, {
              images: toPiImages(message.images),
              streamingBehavior: "steer",
            }),
        },
      );
      if (working) {
        expect(toolFinished).toBe(false);
        expect(contexts).toHaveLength(1);
        releaseTool();
        await running;
        expect(toolFinished).toBe(true);
      }
      expect(
        session.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.stopReason),
      ).not.toContain("error");
      const users = session.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(working ? 2 : 1);
      const expected = [{ type: "text", text: "first\n\nsecond" }, ...toPiImages(images)];
      expect(users.at(-1)?.content).toEqual(expected);
      expect(
        contexts
          .at(-1)
          ?.messages.filter((message) => message.role === "user")
          .at(-1)?.content,
      ).toEqual(expected);
      if (working)
        expect(contexts.at(-1)?.messages.some((message) => message.role === "toolResult")).toBe(
          true,
        );
    } finally {
      releaseTool();
      await session.abort();
      session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
