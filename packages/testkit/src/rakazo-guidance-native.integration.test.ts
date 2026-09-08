import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPiRuntime } from "@rakazo/adapters";
import { expect, it, vi } from "vitest";
import { RAKAZO_SKILL_PATH } from "../../adapters/src/rakazo-guidance.js";
import { resolvePiKit } from "../../pi-kit/src/index.js";
import { startModelEmulator } from "./model-emulator.js";

it.each([false, true])(
  "stock native Pi preserves profile resources and reads Rakazo skill (Fabric=%s)",
  async (fabric) => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-guidance-native-"));
    const profile = join(root, "profile");
    const cwd = join(root, "workspace");
    const skillContent = await readFile(RAKAZO_SKILL_PATH, "utf8");
    const emulator = await startModelEmulator({
      steps: [
        {
          expect: (request) => {
            const prompt = request.messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n");
            expect(prompt).toContain("You are an expert coding assistant");
            expect(prompt).toContain("profile-extension-proof");
            expect(prompt).toContain("profile-context-proof");
            expect(prompt).toContain("profile-skill-proof");
            expect(prompt).toContain(RAKAZO_SKILL_PATH);
            expect(prompt).toContain("native_probe");
            expect(prompt).not.toContain("## Bots and self-template generation");
            if (fabric) {
              expect(request.tools?.map((tool) => tool.function.name)).toEqual(["fabric_exec"]);
              expect(prompt).toContain("fabric_exec using pi.read");
              expect(prompt).toContain("extensions.native_probe");
            } else {
              expect(prompt).not.toContain("fabric_exec using pi.read");
              expect(prompt).not.toContain("extensions.native_probe");
              expect(request.tools?.map((tool) => tool.function.name)).toEqual(
                expect.arrayContaining(["read", "bash", "edit", "write", "native_probe"]),
              );
            }
          },
          response: fabric
            ? {
                type: "tool",
                id: "read-skill",
                name: "fabric_exec",
                arguments: {
                  code: `return await pi.read({path: ${JSON.stringify(RAKAZO_SKILL_PATH)}});`,
                },
              }
            : {
                type: "tool",
                id: "read-skill",
                name: "read",
                arguments: { path: RAKAZO_SKILL_PATH },
              },
        },
        {
          expect: (request) => {
            const results = JSON.stringify(
              request.messages.filter((message) => message.role === "tool"),
            );
            for (const line of skillContent.split("\n").filter(Boolean))
              expect(results).toContain(JSON.stringify(line).slice(1, -1));
          },
          response: { type: "text", text: "skill-read-proof" },
        },
      ],
    });
    try {
      await Promise.all([mkdir(profile), mkdir(cwd)]);
      const kit = resolvePiKit();
      const extension = join(profile, "profile.ts");
      const skill = join(profile, "SKILL.md");
      await writeFile(
        extension,
        'export default function(pi) { pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nprofile-extension-proof" })); }',
      );
      await writeFile(
        skill,
        "---\nname: profile-test\ndescription: profile-skill-proof\n---\nProfile skill content.\n",
      );
      await writeFile(join(profile, "AGENTS.md"), "profile-context-proof");
      await writeFile(
        join(profile, "settings.json"),
        JSON.stringify({
          defaultProvider: "offline",
          defaultModel: "offline-fixture",
          defaultThinkingLevel: "off",
          packages: [],
          extensions: [extension, ...(fabric ? [kit.extensionPaths[0]] : [])],
          skills: [skill],
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
      for (const name of Object.keys(process.env))
        if (/^(PI_|FABRIC_)/.test(name)) vi.stubEnv(name, undefined);
      vi.stubEnv("PI_CODING_AGENT_DIR", profile);
      vi.stubEnv("PI_OFFLINE", "1");
      const runtime = new LocalPiRuntime({
        command: kit.cli,
        cwd,
        sessionDir: join(root, "sessions"),
      });
      const events = [];
      for await (const event of runtime.run(
        {
          botId: "bot",
          threadId: "thread",
          runId: "run",
          sourceMessageId: "source",
          prompt: "Read the Rakazo skill.",
          instructions: "Fixture instructions.",
          history: [],
          model: { provider: "pi-local", id: "default" },
          tools: [
            {
              name: "native_probe",
              description: "Fixture tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          executeTool: async () => "unused",
        },
        { signal: AbortSignal.timeout(45000) },
      ))
        events.push(event);
      emulator.assertComplete();
      expect(JSON.stringify(events)).toContain("skill-read-proof");
    } catch (error) {
      // Reveal fixture assertions instead of the provider's generic HTTP error.
      emulator.assertComplete();
      throw error;
    } finally {
      vi.unstubAllEnvs();
      await emulator.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
