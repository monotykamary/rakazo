import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { createTestProcessHost } from "../../adapters/src/pi-rpc-test-host.js";
import { EVAL_CASES } from "./evals/cases.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)("offline Slack customer-support eval", () => {
  it("runs the messaging, Salesforce, Zendesk, and reply path through the product", async () => {
    const fixtureKey = "offline-customer-support-key";
    const fabricTool = (id: string, name: string, args: Record<string, unknown>) => ({
      type: "tool" as const,
      id,
      name: "fabric_exec",
      arguments: {
        code: `return await extensions.${name}(${JSON.stringify(args)});`,
        resultFormat: "json",
      },
    });
    const toolStep = (
      name: string,
      id: string,
      args: Record<string, unknown>,
      priorResult?: string,
    ) => ({
      expect(request: ModelEmulatorRequest) {
        if (priorResult) {
          const result = request.messages.findLast((message) => message.role === "tool");
          const envelope = JSON.parse(String(result?.content)) as {
            isError: boolean;
            text: string;
          };
          expect(envelope.isError).toBe(false);
          expect(envelope.text).toContain(priorResult);
        }
      },
      response: fabricTool(id, name, args),
    });
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Fairhaven Robotics");
            // Connector tools are reachable only through the sealed Fabric surface;
            // the following extension calls prove they were exposed to this run.
            expect(request.tools?.map((entry) => entry.function.name)).toEqual(["fabric_exec"]);
          },
          response: fabricTool("salesforce-search", "SALESFORCE_SEARCH_ACCOUNTS", {
            query: "Fairhaven Robotics",
          }),
        },
        toolStep(
          "SALESFORCE_LIST_OPPORTUNITIES",
          "salesforce-opportunities",
          { accountId: "sf-fairhaven-robotics" },
          "sf-fairhaven-robotics",
        ),
        toolStep(
          "ZENDESK_SEARCH_ORGANIZATIONS",
          "zendesk-search",
          {
            query: "Fairhaven Robotics",
          },
          "Negotiation",
        ),
        toolStep(
          "ZENDESK_LIST_TICKETS",
          "zendesk-tickets",
          { organizationId: "zd-fairhaven-robotics" },
          "zd-fairhaven-robotics",
        ),
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("zendesk-tickets");
            const envelope = JSON.parse(String(result?.content)) as { text: string };
            expect(envelope.text).toContain("ZD-1842");
          },
          response: {
            type: "text",
            text: "Casey Morgan owns the renewal, now in Negotiation. Urgent ticket ZD-1842 covers the production SSO incident, and engineering is testing a configuration fix.",
          },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-customer-eval-"));
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const scenario = EVAL_CASES.find((candidate) => candidate.id === "slack-customer-update")!;
      const result = await runTrial(scenario, 1, {
        connection: {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
        },
        timeoutMs: 20_000,
        maxToolCalls: 8,
        createApp: async (composio, messaging) => {
          const sandbox = new EvalSandboxProvider();
          const handles = await createApp({
            sandbox,
            databaseUrl: process.env.DATABASE_URL!,
            realtimeDatabaseUrl: process.env.DATABASE_URL!,
            authUrl: "http://127.0.0.1:5173",
            webOrigin: "http://127.0.0.1:5173",
            dataDir,
            sandboxProvider: "fake",
            agentRuntime: "pi",
            wakeupDriver: "memory",
            signupsEnabled: "true",
            composio,
            messaging,
            messagingOpenSignup: false,
            cloudAgentProvider: "none",
            encryptionKey: "offline-customer-eval-encryption-key",
          });
          // Real sealed Pi over a real RPC worker; never a production supervisor host.
          // abort stays bound so trial cleanup can stop a paused worker too.
          const runtime = new PiAgentRuntime({ host: createTestProcessHost() });
          handles.runtime.run = runtime.run.bind(runtime);
          handles.runtime.abort = runtime.abort.bind(runtime);
          return handles;
        },
      });

      model.assertComplete();
      expect(result).toMatchObject({
        status: "passed",
        category: null,
        cleanupFailed: false,
        toolCalls: 4,
      });
      expect(result.criteria.every((criterion) => criterion.pass)).toBe(true);
    } finally {
      try {
        await model.close();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
