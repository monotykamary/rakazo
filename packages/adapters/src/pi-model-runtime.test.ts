import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalPiModelRuntimeService", () => {
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

  it("terminates an in-flight probe when aborted", async () => {
    const { root, service } = await fixture({ hangOnCommand: "get_available_models" });
    const controller = new AbortController();
    const reading = service.read(controller.signal);
    let start: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100 && !start; attempt += 1) {
      start = (await readLocalPiEmulatorLog(root)).find((entry) => entry.type === "start");
      if (!start) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(start?.pid).toEqual(expect.any(Number));
    controller.abort(new Error("cancelled"));

    await expect(reading).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(() => process.kill(start!.pid as number, 0)).toThrow();
  });
});
