import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLocalPiEmulatorLog,
  writeLocalPiEmulator,
  writeLocalPiScenario,
} from "./pi-local-runtime-test-helper.js";
import { LocalPiModelRuntimeService } from "./pi-model-runtime.js";

const roots: string[] = [];

async function fixture(scenario: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "rakazo-pi-model-"));
  roots.push(root);
  const command = await writeLocalPiEmulator(root);
  await writeLocalPiScenario(root, scenario);
  return {
    root,
    command,
    service: new LocalPiModelRuntimeService({
      command,
      cwd: root,
      sessionDir: join(root, "sessions"),
    }),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalPiModelRuntimeService", () => {
  it("supports a new root session without accepting foreign or malformed checkpoints", async () => {
    const { service } = await fixture();
    expect(service.supportsCheckpoint({})).toBe(true);
    for (const checkpoint of [
      null,
      undefined,
      [],
      "",
      { runtime: "managed" },
      { runtime: "pi-local", cwdHash: "foreign" },
    ])
      expect(service.supportsCheckpoint(checkpoint)).toBe(false);
  });

  it("keeps forwarding Pi wrappers on the caller PATH when package runners shadow Pi", async () => {
    const { root, command } = await fixture({
      availableModels: [{ provider: "offline", id: "actual" }],
    });
    const shim = join(root, "shim");
    const caller = join(root, "caller");
    const packageBin = join(root, "package-bin");
    await Promise.all([shim, caller, packageBin].map((dir) => mkdir(dir)));
    await writeFile(join(caller, "pi"), await readFile(command), { mode: 0o700 });
    await writeFile(join(packageBin, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(join(shim, "pi"), `#!/bin/sh\nPATH=\${PATH#*:}\nexport PATH\nexec pi "$@"\n`, {
      mode: 0o700,
    });
    const service = new LocalPiModelRuntimeService({
      command: join(shim, "pi"),
      cwd: root,
      sessionDir: join(root, "sessions"),
    });
    const suffix = process.env.PATH ?? "/usr/bin:/bin";
    const packagePath = `${shim}:${packageBin}:${caller}:${suffix}`;
    vi.stubEnv("PATH", packagePath);
    vi.stubEnv("RAKAZO_DEV_PI_PATH", undefined);
    await expect(service.read()).rejects.toThrow();
    vi.stubEnv("RAKAZO_DEV_PI_PATH", `${shim}:${caller}:${suffix}`);
    await expect(service.read()).resolves.toMatchObject({
      catalog: [{ provider: "offline", id: "actual" }],
    });
    expect(process.env.PATH).toBe(packagePath);
    expect((await readLocalPiEmulatorLog(root)).some((message) => message.type === "prompt")).toBe(
      false,
    );
  });

  it("reads Pi's runtime catalog and current profile model", async () => {
    const { service } = await fixture({
      provider: "profile-provider",
      model: "profile-model",
      thinkingLevel: "medium",
      availableModels: [
        { provider: "profile-provider", id: "profile-model", name: "Profile", reasoning: true },
        { provider: "extension-provider", id: "extension-model", name: "Extension" },
      ],
      thinkingLevels: ["off", "medium", "high"],
    });

    await expect(service.read()).resolves.toEqual({
      catalog: [
        {
          provider: "profile-provider",
          id: "profile-model",
          label: "Profile",
          billing: "Pi",
          reasoning: true,
          thinkingLevels: ["off", "medium", "high"],
        },
        {
          provider: "extension-provider",
          id: "extension-model",
          label: "Extension",
          billing: "Pi",
          reasoning: false,
          thinkingLevels: ["off", "medium", "high"],
        },
      ],
      profileDefault: {
        provider: "profile-provider",
        modelId: "profile-model",
        thinkingLevel: "medium",
      },
    });
  });

  it("reuses successful reads and returns defensive copies", async () => {
    const { root, service } = await fixture({
      provider: "offline",
      model: "cached",
      availableModels: [{ provider: "offline", id: "cached", reasoning: true }],
    });

    const first = await service.read();
    first.catalog[0]!.id = "mutated";
    first.catalog[0]!.thinkingLevels!.push("max");
    first.profileDefault!.modelId = "mutated";
    const second = await service.read();

    expect(second.catalog[0]).toMatchObject({ id: "cached", thinkingLevels: ["off", "medium"] });
    expect(second.profileDefault?.modelId).toBe("cached");
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
  });

  it("singleflights concurrent reads", async () => {
    const { root, service } = await fixture();

    const [first, second] = await Promise.all([service.read(), service.read()]);

    expect(second).toEqual(first);
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
  });

  it("keys cached profiles by canonical cwd without crossing project settings", async () => {
    const { root, service } = await fixture({
      provider: "root-provider",
      model: "root-model",
      availableModels: [{ provider: "root-provider", id: "root-model" }],
    });
    const project = join(root, "project");
    const alias = join(root, "project-alias");
    await mkdir(project);
    await writeLocalPiScenario(project, {
      provider: "project-provider",
      model: "project-model",
      availableModels: [{ provider: "project-provider", id: "project-model" }],
    });
    await symlink(project, alias, "dir");

    const projectProfile = await service.read(undefined, project);
    const aliasProfile = await service.read(undefined, alias);
    const rootProfile = await service.read();

    expect(aliasProfile).toEqual(projectProfile);
    expect(projectProfile.catalog[0]?.id).toBe("project-model");
    expect(rootProfile.catalog[0]?.id).toBe("root-model");
    expect(
      (await readLocalPiEmulatorLog(project)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
  });

  it("expires successful profiles after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { root, service } = await fixture({
      model: "first",
      availableModels: [{ provider: "offline", id: "first" }],
    });
    await service.read();
    await writeLocalPiScenario(root, {
      model: "second",
      availableModels: [{ provider: "offline", id: "second" }],
    });

    vi.setSystemTime(new Date("2026-01-01T00:04:59.999Z"));
    expect((await service.read()).catalog[0]?.id).toBe("first");
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    expect((await service.read()).catalog[0]?.id).toBe("second");
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(2);
  });

  it("refreshes explicitly, drops stale success on failure, and retries failures", async () => {
    const { root, service } = await fixture({
      model: "first",
      availableModels: [{ provider: "offline", id: "first" }],
    });
    await service.read();
    await writeLocalPiScenario(root, {
      model: "second",
      availableModels: [{ provider: "offline", id: "second" }],
    });
    expect((await service.read(undefined, undefined, { refresh: true })).catalog[0]?.id).toBe(
      "second",
    );

    await writeLocalPiScenario(root, { exitOnCommand: "get_available_models" });
    await expect(service.read(undefined, undefined, { refresh: true })).rejects.toMatchObject({
      code: "PI_DISCONNECTED",
    });
    await writeLocalPiScenario(root, {
      model: "third",
      availableModels: [{ provider: "offline", id: "third" }],
    });
    expect((await service.read()).catalog[0]?.id).toBe("third");
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(4);
  });

  it("bounds canonical cwd cache entries", async () => {
    const { root, service } = await fixture();
    const projects: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const project = join(root, `project-${index}`);
      projects.push(project);
      await mkdir(project);
      await writeLocalPiScenario(project, {
        model: `model-${index}`,
        availableModels: [{ provider: "offline", id: `model-${index}` }],
      });
      await service.read(undefined, project);
    }

    await service.read(undefined, projects[0]);

    expect(
      (await readLocalPiEmulatorLog(projects[0]!)).filter((entry) => entry.type === "start"),
    ).toHaveLength(2);
    expect(
      (await readLocalPiEmulatorLog(projects[16]!)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
  });

  it("keeps validate uncached", async () => {
    const { root, service } = await fixture();
    const selection = {
      provider: "offline",
      modelId: "offline-model",
      thinkingLevel: "off" as const,
    };

    await service.read();
    await service.read();
    await service.validate(selection);
    await service.validate(selection);

    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(3);
  });

  it("keeps the full catalog and only whitelisted metadata", async () => {
    const availableModels = Array.from({ length: 1001 }, (_, index) => ({
      provider: "offline",
      id: `model-${index}`,
      name: "Model",
      apiKey: "fake-secret",
    }));
    const { root, service } = await fixture({ availableModels });
    const profile = await service.read();
    expect(profile.catalog).toHaveLength(1001);
    expect(profile.catalog.at(-1)?.id).toBe("model-1000");
    expect(JSON.stringify(profile)).not.toContain("fake-secret");
    const log = await readLocalPiEmulatorLog(root);
    expect(
      log.filter((entry) => entry.type === "command").map((entry) => entry.command),
    ).not.toContainEqual(expect.objectContaining({ type: "prompt" }));
  });

  it("rejects invalid identities without trimming or truncating them into valid models", async () => {
    const { service } = await fixture({
      availableModels: [
        { provider: " offline", id: "model" },
        { provider: "offline", id: "model " },
        { provider: "offline", id: "x".repeat(301) },
        { provider: "p".repeat(101), id: "model" },
        { provider: "offline", id: "valid/model" },
      ],
    });
    expect((await service.read()).catalog.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: "offline", id: "valid/model" },
    ]);
  });

  it.each(["exitOnCommand", "hangOnCommand"])(
    "never returns a partial catalog after %s",
    async (fault) => {
      const { service } = await fixture({
        availableModels: [
          { provider: "offline", id: "first" },
          { provider: "offline", id: "second" },
        ],
        [fault]: "get_available_thinking_levels",
        faultModel: "second",
      });
      await expect(service.read()).rejects.toMatchObject({
        code: fault === "hangOnCommand" ? "PI_DISCOVERY_TIMEOUT" : "PI_DISCONNECTED",
      });
    },
    20_000,
  );

  it("does not call malformed catalog metadata an available empty inventory", async () => {
    const { service } = await fixture({ availableModels: { unexpected: true } });
    await expect(service.read()).rejects.toMatchObject({ code: "PI_PROTOCOL_FAILED" });
  });

  it("classifies extension stdout logging without exposing its contents", async () => {
    const { command, service } = await fixture();
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.stdout.write("fake-private-log\\n");\nprocess.stdin.resume();\n`,
    );
    await expect(service.read()).rejects.toMatchObject({
      name: "PiModelRuntimeError",
      code: "PI_PROTOCOL_FAILED",
      message: "PI_PROTOCOL_FAILED",
    });
  });

  it("rejects a successful set_model response whose state did not acknowledge selection", async () => {
    const { service } = await fixture({ ignoreModelSelection: true });
    await expect(
      service.validate({ provider: "offline", modelId: "different", thinkingLevel: null }),
    ).rejects.toThrow("Model is unavailable in Pi");
  });

  it("asks Pi to validate the selected model and reasoning level", async () => {
    const { service } = await fixture({ thinkingLevels: ["off", "high"] });

    await expect(
      service.validate({
        provider: "extension-provider",
        modelId: "extension-model",
        thinkingLevel: "high",
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.validate({
        provider: "extension-provider",
        modelId: "extension-model",
        thinkingLevel: "max",
      }),
    ).rejects.toThrow("Reasoning level is unavailable in Pi");
  });

  it("probes project settings only from a cwd confined beneath the trusted root", async () => {
    const { root, service } = await fixture();
    const project = join(root, "project");
    await mkdir(project);
    await writeLocalPiScenario(project, {
      provider: "project-provider",
      model: "project-model",
      availableModels: [{ provider: "project-provider", id: "project-model", name: "Project" }],
    });

    const profile = await service.read(undefined, project);

    expect(profile.catalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "project-provider/project-model",
    ]);
    await expect(service.read(undefined, tmpdir())).rejects.toThrow("PI_WORKSPACE_UNAVAILABLE");
  });

  it("rejects a missing Pi executable without an uncaught child error", async () => {
    const { root } = await fixture();
    const service = new LocalPiModelRuntimeService({
      command: join(root, "missing-pi"),
      cwd: root,
      sessionDir: join(root, "sessions"),
    });

    await expect(service.read()).rejects.toThrow("PI_START_FAILED");
  });

  it("isolates caller cancellation from a shared profile probe", async () => {
    const availableModels = Array.from({ length: 300 }, (_, index) => ({
      provider: "offline",
      id: `model-${index}`,
    }));
    const { root, service } = await fixture({ availableModels });
    const controller = new AbortController();
    const cancelled = service.read(controller.signal);
    let started = false;
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
      started = (await readLocalPiEmulatorLog(root)).some((entry) => entry.type === "start");
      if (!started) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(true);
    const surviving = service.read();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    await expect(surviving).resolves.toMatchObject({ catalog: expect.any(Array) });
    expect(
      (await readLocalPiEmulatorLog(root)).filter((entry) => entry.type === "start"),
    ).toHaveLength(1);
  });
});
