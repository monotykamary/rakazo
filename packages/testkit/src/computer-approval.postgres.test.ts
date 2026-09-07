import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, FakeSandboxProvider, PiAgentRuntime } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestProcessHost } from "../../adapters/src/pi-rpc-test-host.js";
import { sessionCookieHeader } from "./index.js";
import {
  type ModelEmulatorRequest,
  type ModelEmulatorStep,
  startModelEmulator,
} from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

/** Sealed Fabric tool call: the model reaches every Rakazo capability through extensions.<name>. */
const fabricCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelEmulatorStep["response"] => ({
  type: "tool",
  id,
  name: "fabric_exec",
  arguments: {
    code: `return await extensions.${name}(${JSON.stringify(args)});`,
    resultFormat: "json",
  },
});

function toolContent(request: ModelEmulatorRequest, id: string) {
  const result = request.messages.findLast((message) => message.role === "tool");
  expect(result?.tool_call_id).toBe(id);
  return String(result?.content);
}

/** Sealed Fabric returns extension results as an envelope so image parts survive the broker. */
function toolEnvelope(request: ModelEmulatorRequest, id: string) {
  return JSON.parse(toolContent(request, id)) as {
    isError: boolean;
    text: string;
    content?: Array<Record<string, unknown>>;
  };
}

describe.skipIf(!databaseAvailable)("offline Pi computer approval", () => {
  beforeAll(() => {
    // Use the existing compatible-endpoint capability declaration so the real
    // executor exposes computer tools without mocking its model vision gate.
    vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "offline-fixture");
  });
  afterAll(() => vi.unstubAllEnvs());

  it.each(["allow", "deny"] as const)(
    "%s checkpoints approval before stopping on a buffered computer_act start",
    async (answer) => {
      let sandbox: FakeSandboxProvider;
      const approvedArgs = {
        actions: [{ kind: "type", text: "approved clipboard content" }],
        observe: false,
        settle_ms: 0,
      };
      // Inspect the provider state while the run still owns its screen;
      // completed runs release that screen and discard its placeholder state.
      const checkScreens = () => {
        const screens = [...sandbox.boxes.values()].flatMap((box) => [...box.screens.values()]);
        expect(screens).not.toContain("unapproved replacement");
        if (answer === "allow") expect(screens).toContain("approved clipboard content");
        else expect(screens).not.toContain("approved clipboard content");
      };
      const fixtureKey = "offline-computer-approval-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              // The vision-capable model declaration must expose the computer tools,
              // and sealed Fabric must surface them as the single model-side tool.
              expect(request.tools).toEqual([
                expect.objectContaining({
                  function: expect.objectContaining({ name: "fabric_exec" }),
                }),
              ]);
            },
            // Product-path vision proof: a model-visible screenshot crosses the
            // executor, the RPC worker, and sealed Fabric as a real image part.
            response: fabricCall("observe", "computer_observe", {}),
          },
          {
            expect(request) {
              const envelope = toolEnvelope(request, "observe");
              expect(envelope.isError).toBe(false);
              expect(String(envelope.text)).toContain("computer observed");
              const image = envelope.content?.find((part) => part.type === "image") as
                | { mimeType: string; data: string }
                | undefined;
              expect(image?.mimeType).toBe("image/png");
              expect([...Buffer.from(image!.data, "base64").subarray(0, 8)]).toEqual([
                137, 80, 78, 71, 13, 10, 26, 10,
              ]);
            },
            response: fabricCall("pending-action", "computer_act", approvedArgs),
          },
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("approved clipboard content");
            },
            response: fabricCall(
              "resumed-action",
              "computer_act",
              // The executor must restore exactly what the user approved, even if
              // the model reconstructs different arguments after its run resumes.
              answer === "allow"
                ? {
                    ...approvedArgs,
                    actions: [{ kind: "type", text: "unapproved replacement" }],
                  }
                : approvedArgs,
            ),
          },
          ...(answer === "allow"
            ? [
                {
                  expect(request) {
                    const envelope = toolEnvelope(request, "resumed-action");
                    expect(envelope.isError).toBe(false);
                    expect(JSON.parse(envelope.text)).toMatchObject({ ok: true, completed: 1 });
                    checkScreens();
                  },
                  response: fabricCall("duplicate-action", "computer_act", approvedArgs),
                },
              ]
            : []),
          {
            expect(request) {
              if (answer === "allow") {
                const envelope = toolEnvelope(request, "duplicate-action");
                expect(envelope.isError).toBe(false);
                expect(JSON.parse(envelope.text)).toMatchObject({ ok: true, completed: 1 });
              } else {
                // Fabric surfaces rejected extension calls as error text, not a JSON envelope.
                expect(toolContent(request, "resumed-action")).toMatch(/denied/i);
              }
              checkScreens();
            },
            response: { type: "text", text: "Finished the approval fixture." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-approval-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-computer-fixture-encryption-key",
        });
        stop = handles.stop;
        expect(handles.sandbox).toBeInstanceOf(FakeSandboxProvider);
        sandbox = handles.sandbox as FakeSandboxProvider;
        // Keep the real fake-provider implementation; observe calls and its state
        // independently of the model's claims and the persisted effect record.
        const act = vi.spyOn(sandbox, "act");
        // Real sealed Pi over a real RPC worker; never a production supervisor host.
        const runtime = new PiAgentRuntime({ host: createTestProcessHost() });
        handles.runtime.abort = runtime.abort.bind(runtime);
        const approvalOrder: string[] = [];
        let bufferApprovalStart = true;
        handles.runtime.run = async function* (request, context) {
          if (!bufferApprovalStart) {
            yield* runtime.run(request, context);
            return;
          }
          bufferApprovalStart = false;
          const executeTool = request.executeTool!;
          const session = request.session!;
          expect(executeTool).toBeTypeOf("function");
          expect(session).toBeDefined();
          let releaseComputerAct!: () => void;
          const computerActReturned = new Promise<void>((resolve) => {
            releaseComputerAct = resolve;
          });
          const events = runtime.run(
            {
              ...request,
              executeTool: async (...args) => {
                const result = await executeTool(...args);
                if (args[0] === "computer_act") {
                  approvalOrder.push("callback_returned");
                  releaseComputerAct();
                }
                return result;
              },
              session: {
                ...session,
                async save(state) {
                  const approvalCheckpoint = approvalOrder.length > 0;
                  if (approvalCheckpoint)
                    expect(approvalOrder).toEqual(["callback_returned", "buffered_start_yielded"]);
                  await session.save(state);
                  if (approvalCheckpoint) approvalOrder.push("checkpoint_saved");
                },
              },
            },
            context,
          );
          for await (const event of events) {
            if (
              event.type === "execution" &&
              event.name === "computer_act" &&
              event.status === "started"
            ) {
              // The real RPC bridge invokes the callback independently of this iterator.
              // Release its buffered start after the pause latch, before the worker checkpoint.
              await computerActReturned;
              expect(approvalOrder).toEqual(["callback_returned"]);
              approvalOrder.push("buffered_start_yielded");
            }
            yield event;
          }
        };
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `computer-approval-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Computer approval fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        await rpc(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Computer fixture",
          title: "",
          description: "",
          instructions: "Complete the computer task.",
          notifyOnFinish: false,
        });
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "computer_act",
          },
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Put approved clipboard content on the computer clipboard.",
        });
        const waitForRun = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await handles.prisma.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") model.assertComplete();
                return run.status;
              },
              { timeout: 15_000, interval: 100 },
            )
            .toBe(status);
        };
        await waitForRun("waiting_input");
        expect(approvalOrder).toEqual([
          "callback_returned",
          "buffered_start_yielded",
          "checkpoint_saved",
        ]);
        expect(model.requests).toHaveLength(2);
        expect(act).not.toHaveBeenCalled();
        const effects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({
          kind: "computer_act",
          status: "intended",
          request: approvedArgs,
        });
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "ask", approvalEffectId: effects[0]!.id }),
          ]),
        );
        await rpc(handles.app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer,
        });
        await waitForRun("completed");
        model.assertComplete();
        expect(act).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        if (answer === "allow") {
          expect(act.mock.calls[0]![1]).toEqual({
            actions: [{ kind: "clipboard", text: "approved clipboard content" }],
            observe: false,
            settleMs: 0,
          });
        }
        const settledEffects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(settledEffects).toHaveLength(1);
        expect(settledEffects[0]).toMatchObject({
          id: effects[0]!.id,
          status: answer === "allow" ? "completed" : "denied",
          request: approvedArgs,
        });
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    45_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
