import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isModelHidden, type ModelVisibility, ModelVisibilitySchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manageModelVisibilityExtension } from "./pi-managed-visibility.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function archiveFixture() {
  const root = await mkdtemp(join(tmpdir(), "rakazo-hide-providers-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(new URL("../../../vendor/pi-kit/manifest.json", import.meta.url), "utf8"),
  );
  const artifact = manifest.packages.find(
    (entry: { name: string }) => entry.name === "pi-hide-providers",
  );
  expect(artifact.version).toBe("0.1.18");
  execFileSync("tar", [
    "-xzf",
    fileURLToPath(new URL(`../../../vendor/pi-kit/${artifact.filename}`, import.meta.url)),
    "-C",
    root,
  ]);
  return { root, entry: join(root, "package/hide-providers.ts") };
}

async function headless(managed: boolean) {
  const { root, entry } = await archiveFixture();
  const scratch = join(root, "scratch");
  const agentDir = join(scratch, "agent");
  const computer = join(root, "computer");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(computer, ".pi"), { recursive: true });
  const projectConfig = join(computer, ".pi/hide-providers.json");
  const globalConfig = join(agentDir, "hide-providers.json");
  await writeFile(globalConfig, JSON.stringify({ hide: [] }));
  await writeFile(
    projectConfig,
    JSON.stringify({ hide: [{ provider: "rakazo-broker", model: "pinned" }] }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [entry],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);
  const extension = loader.getExtensions().extensions[0]!;
  if (managed) manageModelVisibilityExtension(extension, scratch);
  const credentials = new InMemoryCredentialStore();
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(scratch, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerProvider("rakazo-broker", {
    api: "openai-completions",
    baseUrl: "http://invalid.invalid",
    apiKey: "fake-offline-key",
    models: ["pinned", "other"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  await models.refresh({ providers: ["rakazo-broker"], allowNetwork: false });
  const pinned = models.getModel("rakazo-broker", "pinned")!;
  const paid = vi.spyOn(models, "streamSimple").mockImplementation(() => {
    throw new Error("No model calls allowed");
  });
  const manager = SessionManager.inMemory(computer);
  manager.appendModelChange(pinned.provider, pinned.id);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: computer,
    agentDir,
    modelRuntime: models,
    model: pinned,
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
    tools: [],
    noTools: "all",
  });
  cleanups.push(async () => {
    session.dispose();
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  expect(errors).toEqual([]);
  expect(modelFallbackMessage).toBeUndefined();
  return { session, models, extension, paid, manager, errors, globalConfig, projectConfig };
}

describe("packaged pi-hide-providers conformance", () => {
  it("matches the upstream predicate on the bounded exact-rule subset", async () => {
    const { root } = await archiveFixture();
    const upstream = (await import(pathToFileURL(join(root, "package/src/index.ts")).href)) as {
      isHidden(rules: ModelVisibility["hide"], provider: string, id: string): boolean;
    };
    const ids = ["model", "model/v2", "model.v2", "literal[1]+(x)$", "Model", "other"];
    for (const provider of ["local", "Local", "other", "rakazo-broker"]) {
      for (const selected of [undefined, ...ids]) {
        const visibility = ModelVisibilitySchema.parse({
          hide: [{ provider: "local", ...(selected === undefined ? {} : { model: selected }) }],
        });
        for (const id of ids)
          expect(isModelHidden(visibility, provider, id)).toBe(
            upstream.isHidden(visibility.hide, provider, id),
          );
      }
    }
    expect(isModelHidden({ hide: [] }, "local", "model")).toBe(
      upstream.isHidden([], "local", "model"),
    );
  });

  it("headlessly loads real upstream hooks and restores lookup/list access after unhide", async () => {
    const f = await headless(false);
    expect(f.models.getModel("rakazo-broker", "pinned")).toBeUndefined();
    expect(f.models.getModels("rakazo-broker").map((model) => model.id)).toEqual(["other"]);
    expect((await f.models.getAvailable("rakazo-broker")).map((model) => model.id)).toEqual([
      "other",
    ]);
    expect(
      f.models
        .getAvailableSnapshot()
        .filter((model) => model.provider === "rakazo-broker")
        .map((model) => model.id),
    ).toEqual(["other"]);
    await f.session.prompt("/hide-models remove rakazo-broker/pinned");
    expect(f.models.getModel("rakazo-broker", "pinned")).toBeDefined();
    expect(f.models.getModels("rakazo-broker")).toHaveLength(2);
    await f.session.prompt("/hide-models add rakazo-broker");
    expect(f.models.getModels("rakazo-broker")).toEqual([]);
    await f.session.prompt("/hide-models reset");
    expect(f.models.getModel("rakazo-broker", "pinned")).toBeDefined();
    expect(f.paid).not.toHaveBeenCalled();
  });

  it("managed workers ignore computer config and reject every local visibility command without writes or pin changes", async () => {
    const f = await headless(true);
    const before = await Promise.all([
      readFile(f.globalConfig, "utf8"),
      readFile(f.projectConfig, "utf8"),
    ]);
    const entries = f.manager.getEntries();
    expect(f.models.getModel("rakazo-broker", "pinned")).toBeDefined();
    expect(f.models.getModels("rakazo-broker")).toHaveLength(2);
    expect([...f.extension.commands.keys()]).toEqual(["hide-models"]);
    for (const command of [
      "",
      "add rakazo-broker",
      "remove rakazo-broker/pinned",
      "reset",
      "status",
      "apply",
    ]) {
      // Pi reports command exceptions through extension_error, not prompt rejection.
      await f.session.prompt(`/hide-models ${command}`);
      expect(f.errors.at(-1)).toMatchObject({
        error: "Change model visibility in Rakazo model settings.",
      });
    }
    expect(f.errors).toHaveLength(6);
    expect(
      await Promise.all([readFile(f.globalConfig, "utf8"), readFile(f.projectConfig, "utf8")]),
    ).toEqual(before);
    expect(f.manager.getEntries()).toEqual(entries);
    expect(f.session.model?.id).toBe("pinned");
    expect(f.paid).not.toHaveBeenCalled();
  });
});
