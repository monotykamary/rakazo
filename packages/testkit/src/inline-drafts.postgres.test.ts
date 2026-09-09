import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, PiAgentRuntime } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { answerRunInput, updateOutgoingDraft } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createTestProcessHost } from "../../adapters/src/pi-rpc-test-host.js";
import { sessionCookieHeader } from "./index.js";
import { LEGACY_MODEL_FIXTURE_KEY, seedLegacyModelCredential } from "./legacy-model-fixture.js";
import {
  type ModelEmulatorRequest,
  type ModelEmulatorStep,
  startModelEmulator,
} from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Ask = Extract<MessageBlock, { kind: "ask" }>;
const origin = "http://127.0.0.1:5173";
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
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

describe.skipIf(!databaseAvailable)("inline message drafts through the real product", () => {
  it.each(["send", "discard"] as const)(
    "%s is explicit, durable, revision-bound and delivered at most once",
    async (action) => {
      const fixtureKey = "offline-draft-fixture-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request: ModelEmulatorRequest) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({
                  function: expect.objectContaining({ name: "fabric_exec" }),
                }),
              );
            },
            response: fabricCall("draft-message", "draft_message", {
              to: ["recipient@example.test"],
              subject: "Original subject",
              body: "Original body",
            }),
          },
          ...(action === "send"
            ? [
                {
                  // Resumption must restore the persisted human-approved request, not these replacements.
                  expect(request: ModelEmulatorRequest) {
                    expect(JSON.stringify(request.messages)).toContain("Approved body");
                  },
                  response: fabricCall("deliver-message", "GMAIL_SEND_EMAIL", {
                    recipient_email: "unapproved@example.test",
                    subject: "Unapproved subject",
                    body: "Unapproved body",
                  }),
                },
              ]
            : []),
          {
            expect(request: ModelEmulatorRequest) {
              expect(request.messages.length).toBeGreaterThan(0);
            },
            response: {
              type: "text" as const,
              text: action === "send" ? "Message sent." : "Draft discarded.",
            },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-inline-drafts-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const composio = new ComposioEmulator();
        const discover = composio.discoverTools.bind(composio);
        vi.spyOn(composio, "discoverTools").mockImplementation(async (context) =>
          (await discover(context)).map((tool) =>
            tool.name === "GMAIL_SEND_EMAIL"
              ? {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    properties: {
                      ...(tool.inputSchema.properties as Record<string, unknown>),
                      user_id: { type: "string", default: "me" },
                      is_html: { type: "boolean", default: true },
                      cc: {
                        type: "array",
                        items: { type: "string" },
                        default: ["hidden-default@example.test"],
                      },
                      attachment: { type: "object", default: null },
                    },
                  },
                }
              : tool,
          ),
        );
        const delivery = vi.spyOn(composio, "execute");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: origin,
          webOrigin: origin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          runtime: new PiAgentRuntime({ host: createTestProcessHost() }),
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio,
          encryptionKey: LEGACY_MODEL_FIXTURE_KEY,
        });
        stop = handles.stop;
        const runtime = new PiAgentRuntime({ host: createTestProcessHost() });
        handles.runtime.run = runtime.run.bind(runtime);
        handles.runtime.abort = runtime.abort.bind(runtime);
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `draft-${randomUUID()}@example.test`,
            password: "password12",
            name: "Draft fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const actor = await rpc<Actor>(handles.app, cookie, "me");
        await seedLegacyModelCredential(handles.prisma, actor, {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
        });
        await rpc(handles.app, cookie, "connections/begin", {
          connectorId: "composio",
          provider: "GMAIL",
          displayName: "Fixture mailbox",
        });
        await rpc(handles.app, cookie, "connections/catalog", { connectorId: "composio" });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Draft fixture",
          title: "",
          description: "",
          instructions: "Stage a message for explicit human review.",
          notifyOnFinish: false,
        });
        await handles.prisma.bot.update({
          where: { id: bot.id },
          data: { modelProvider: model.model.provider, modelId: model.model.id },
        });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: actor.spaceId,
            createdByUserId: actor.userId,
            effect: "always_allow",
            matchKind: "tool",
            matchValue: "GMAIL_SEND_EMAIL",
          },
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Draft an email for me to review before sending.",
        });
        const waitForRun = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await handles.prisma.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") throw new Error(`Draft fixture failed: ${run.error}`);
                return run.status;
              },
              { timeout: 30_000, interval: 100 },
            )
            .toBe(status);
        };
        await waitForRun("waiting_input");
        const loadCard = async () => {
          const messages = await handles.prisma.message.findMany({
            where: { runId: sent.runId },
            orderBy: { seq: "asc" },
          });
          for (const message of messages) {
            const ask = (message.blocks as MessageBlock[]).find(
              (block): block is Ask => block.kind === "ask" && Boolean(block.draft),
            );
            if (ask?.draft) return { message, ask, draft: ask.draft };
          }
          throw new Error("Inline draft card was not persisted");
        };
        const original = await loadCard();
        expect(original.draft.status).toBe("pending");
        expect(
          delivery.mock.calls.filter(([call]) => call.tool === "GMAIL_SEND_EMAIL"),
        ).toHaveLength(0);
        const guarded = {
          spaceId: actor.spaceId,
          threadId: original.message.threadId,
          runId: sent.runId,
          messageId: original.message.id,
          answeredByUserId: "other-viewer",
        };
        expect(
          await answerRunInput(handles.prisma, {
            ...guarded,
            answer: "send",
            expectedDraft: { revision: original.draft.revision, hash: original.draft.hash },
          }),
        ).toBe(false);
        expect(
          await updateOutgoingDraft(handles.prisma, {
            ...guarded,
            approvalEffectId: original.ask.approvalEffectId!,
            expectedRevision: original.draft.revision,
            expectedHash: original.draft.hash,
            fields: { to: ["unapproved@example.test"], body: "Unauthorized edit" },
          }),
        ).toMatchObject({ kind: "forbidden" });
        expect(
          await answerRunInput(handles.prisma, {
            ...guarded,
            answeredByUserId: actor.userId,
            spaceId: "other-space",
            answer: "send",
            expectedDraft: { revision: original.draft.revision, hash: original.draft.hash },
          }),
        ).toBe(false);
        expect((await loadCard()).draft).toEqual(original.draft);
        const fields = {
          to: ["reviewer@example.test"],
          subject: "Approved subject",
          body: "Approved body",
        };
        const updated = await rpc<{ draft: typeof original.draft }>(
          handles.app,
          cookie,
          "threads/updateDraft",
          {
            botId: bot.id,
            runId: sent.runId,
            messageId: original.message.id,
            approvalEffectId: original.ask.approvalEffectId,
            expectedRevision: original.draft.revision,
            expectedHash: original.draft.hash,
            fields,
          },
        );
        expect(updated.draft.revision).toBe(original.draft.revision + 1);
        expect(updated.draft.fields).toMatchObject(fields);
        const answer = {
          botId: bot.id,
          runId: sent.runId,
          messageId: original.message.id,
          answer: action,
        };
        const stale = await request(handles.app, cookie, "threads/answer", {
          ...answer,
          expectedDraft: { revision: original.draft.revision, hash: original.draft.hash },
        });
        expect(stale.status).toBe(409);
        const replies = await Promise.all(
          [0, 1].map(() =>
            request(handles.app, cookie, "threads/answer", {
              ...answer,
              expectedDraft: { revision: updated.draft.revision, hash: updated.draft.hash },
            }),
          ),
        );
        expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
        await waitForRun("completed");
        const final = await loadCard();
        expect(final.draft.status).toBe(action === "send" ? "sent" : "discarded");
        const sends = delivery.mock.calls.filter(([call]) => call.tool === "GMAIL_SEND_EMAIL");
        expect(sends).toHaveLength(action === "send" ? 1 : 0);
        if (action === "send")
          expect(sends[0]![0].args).toMatchObject({
            recipient_email: "reviewer@example.test",
            subject: "Approved subject",
            body: "Approved body",
            cc: [],
            is_html: false,
            user_id: "me",
          });
        expect(final.draft.fields).toMatchObject(fields);
        model.assertComplete();
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );
});

function request(app: App, cookie: string, procedure: string, body: unknown = {}) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: body }),
  });
}
async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await request(app, cookie, procedure, body);
  if (!response.ok) throw new Error(`${procedure}: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { json: T }).json;
}
