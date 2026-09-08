import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createManagedKit, type ManagedKit } from "./pi-managed-kit.js";
import { RAKAZO_SKILL_PATH } from "./rakazo-guidance.js";

it("actual sealed Pi/Fabric reads the whole advertised skill without computer or arbitrary host access", async () => {
  for (const name of Object.keys(process.env))
    if (/^(PI_|FABRIC_)/.test(name)) vi.stubEnv(name, undefined);
  const root = await mkdtemp(join(tmpdir(), "rakazo-skill-test-"));
  let kit: ManagedKit | undefined;
  let runtime: AgentSessionRuntime | undefined;
  try {
    kit = await createManagedKit({
      instructions: "Fixture bot instruction.",
      proxyTools: [],
      scratchRoot: root,
      checkpoint: async () => {},
      activity: async () => {},
    });
    expect(kit.resourceLoader.getSystemPrompt()).toBeUndefined();
    expect(kit.resourceLoader.getSkills().skills.map((skill) => skill.filePath)).toEqual([
      RAKAZO_SKILL_PATH,
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const model: Model<Api> = {
      id: "offline",
      name: "offline",
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://invalid.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    };
    runtime = await createAgentSessionRuntime(
      async ({ sessionManager, sessionStartEvent }) => {
        const services = {
          cwd: root,
          agentDir: root,
          modelRuntime,
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
          resourceLoader: kit!.resourceLoader,
          diagnostics: [],
        };
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            model,
            tools: kit!.activeTools,
            noTools: "builtin",
            customTools: kit!.tools,
          })),
          services,
          diagnostics: [],
        };
      },
      { cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root) },
    );
    await runtime.session.bindExtensions({});
    await kit.initialize(runtime);
    const prompt = runtime.session.agent.state.systemPrompt;
    expect(prompt).toContain("You are an expert coding assistant");
    expect(prompt).toContain("Fixture bot instruction.");
    expect(prompt).not.toContain("## Bots and self-template generation");
    const fabric = runtime.session.agent.state.tools.find((tool) => tool.name === "fabric_exec")!;
    expect(fabric).toBeDefined();
    const exec = (code: string) =>
      fabric.execute("skill-probe", { code }, new AbortController().signal);
    const result = await exec(
      `return await pi.read({path: ${JSON.stringify(RAKAZO_SKILL_PATH)}});`,
    );
    const text = JSON.stringify(result);
    const skill = await readFile(RAKAZO_SKILL_PATH, "utf8");
    for (const line of skill.split("\n").filter(Boolean))
      expect(text).toContain(JSON.stringify(line).slice(1, -1));
    const denied = await exec('return await pi.read({path: "/worker/private.txt"});');
    expect(JSON.stringify(denied)).toContain("Authorized capability unavailable");
    const write = await exec(
      `return await pi.write({path: ${JSON.stringify(RAKAZO_SKILL_PATH)}, text: "no"});`,
    );
    expect(JSON.stringify(write)).toContain("read-only");
  } finally {
    await kit?.dispose();
    await runtime?.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
