import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { LocalPiRuntime } from "@rakazo/adapters";
import { expect, it, vi } from "vitest";
import { resolvePiKit } from "../../pi-kit/src/index.js";
import { startModelEmulator } from "./model-emulator.js";

it.each([false, true])(
  "runs installed Pi with normal model selection and a real product bridge offline (Fabric=%s)",
  async (fabric) => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-native-pi-"));
    const profile = join(root, "profile");
    const cwd = join(root, "workspace");
    const selected = join(cwd, "projects", "selected");
    const executeTool = vi.fn(async () => {
      await writeFile(join(selected, "product-location.txt"), "bridge-proof");
      return "bridge-proof";
    });
    const emulator = await startModelEmulator({
      steps: [
        {
          expect: (request) => {
            const names = request.tools?.map((tool) => tool.function.name);
            if (fabric) expect(names).toEqual(["fabric_exec"]);
            else {
              expect(names).toContain("native_probe");
              expect(names).toContain("read");
            }
          },
          response: fabric
            ? {
                type: "tool",
                id: "read-location",
                name: "fabric_exec",
                arguments: { code: "return await pi.read({path: 'native-location.txt'});" },
              }
            : {
                type: "tool",
                id: "read-location",
                name: "read",
                arguments: { path: "native-location.txt" },
              },
        },
        {
          expect: (request) => {
            const results = request.messages.filter((message) => message.role === "tool");
            expect(JSON.stringify(results)).toContain("selected-proof");
            expect(JSON.stringify(results)).not.toContain("wrong-root");
          },
          response: fabric
            ? {
                type: "tool",
                id: "probe-call",
                name: "fabric_exec",
                arguments: { code: "return await extensions.native_probe({});" },
              }
            : { type: "tool", id: "probe-call", name: "native_probe", arguments: {} },
        },
        {
          expect: (request) => {
            expect(
              request.messages.some(
                (message) =>
                  message.role === "tool" &&
                  JSON.stringify(message.content).includes("bridge-proof"),
              ),
            ).toBe(true);
          },
          response: { type: "text", text: "native-probe-ok" },
        },
      ],
    });
    try {
      await Promise.all([mkdir(profile), mkdir(selected, { recursive: true })]);
      await writeFile(join(cwd, "native-location.txt"), "wrong-root");
      await writeFile(join(selected, "native-location.txt"), "selected-proof");
      const kit = resolvePiKit();
      const command = kit.cli;
      await writeFile(
        join(profile, "settings.json"),
        JSON.stringify({
          defaultProvider: "offline",
          defaultModel: "offline-fixture",
          defaultThinkingLevel: "off",
          packages: [],
          extensions: fabric ? [kit.extensionPaths[0]] : [],
          retry: { enabled: false },
        }),
      );
      await writeFile(
        join(profile, "models.json"),
        JSON.stringify({
          providers: {
            offline: {
              baseUrl: emulator.baseUrl,
              api: "openai-completions",
              apiKey: "local",
              models: [{ id: "offline-fixture" }],
            },
          },
        }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", profile);
      vi.stubEnv("PI_OFFLINE", "1");
      const runtime = new LocalPiRuntime({ command, cwd, sessionDir: join(root, "sessions") });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.run(
        {
          botId: "offline-bot",
          threadId: "offline-thread",
          runId: "offline-run",
          sourceMessageId: "offline-source",
          prompt: "Probe the product bridge.",
          instructions: "Use the available tools.",
          history: [],
          model: { provider: "pi-local", id: "default" },
          tools: [
            {
              name: "native_probe",
              description: "Offline probe",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          placement: { cwd: "projects/selected" },
          authorizeSubagentPlacement: async (placement) => ({ placement, executeTool }),
          executeTool: async () => {
            throw new Error("Unbound product callback");
          },
        },
        { signal: AbortSignal.timeout(45_000) },
      ))
        events.push(event);
      emulator.assertComplete();
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(await readFile(join(selected, "product-location.txt"), "utf8")).toBe("bridge-proof");
      await expect(readFile(join(cwd, "product-location.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(events.some((event) => JSON.stringify(event).includes("native-probe-ok"))).toBe(true);
    } catch (error) {
      emulator.assertComplete();
      throw error;
    } finally {
      vi.unstubAllEnvs();
      await emulator.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
