import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const pkg = read("package.json");
assert(!process.versions.bun, "Install probes must run on Node, not Bun's runtime.");
assert.equal(execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(), pkg.engines.bun);
const workspaces = globSync(
  pkg.workspaces.map((pattern) => `${pattern}/package.json`),
  { cwd: root },
);
const paths = new Map(workspaces.map((path) => [read(path).name, dirname(path)]));
const { parse } = createRequire(import.meta.url)("jsonc-parser");
const errors = [];
const lock = parse(readFileSync(join(root, "bun.lock"), "utf8"), errors, {
  allowTrailingComma: true,
});
assert.equal(errors.length, 0, "Bun lockfile must be valid JSONC.");
assert.equal(lock.configVersion, 1);
assert.deepEqual(lock.overrides, pkg.overrides);
assert.deepEqual(lock.patchedDependencies, pkg.patchedDependencies);
assert.equal(Object.keys(lock.workspaces).length, paths.size + 1);
let links = 0;
for (const path of workspaces) {
  const manifest = read(path);
  const locked = lock.workspaces[dirname(path).replaceAll("\\", "/")];
  assert(locked, `Workspace missing from lockfile: ${manifest.name}`);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.deepEqual(
      locked[field] ?? {},
      manifest[field] ?? {},
      `Lockfile ${field}: ${manifest.name}`,
    );
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!version.startsWith("workspace:")) continue;
    assert(paths.has(name), `Unregistered workspace dependency: ${name}`);
    assert.equal(
      realpathSync(join(root, dirname(path), "node_modules", name)),
      realpathSync(join(root, paths.get(name))),
      `Workspace link: ${name}`,
    );
    links++;
  }
}
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const builder = builderRequire.resolve("app-builder-lib/package.json");
assert.equal(JSON.parse(readFileSync(builder, "utf8")).version, "26.15.3");
const signing = readFileSync(join(dirname(builder), "out/codeSign/macCodeSign.js"), "utf8");
assert(
  signing.includes("importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)"),
  "Electron signing patch was not applied.",
);
assert(
  signing.includes('"-k", keychainPassword, keychainFile]'),
  "Key partition list must use the keychain password.",
);
const coreRequire = createRequire(join(root, "packages/core/package.json"));
const headless = await import(
  pathToFileURL(coreRequire.resolve("pi-queue-steer-factory/headless"))
);
const protocol = await import(
  pathToFileURL(coreRequire.resolve("pi-queue-steer-factory/protocol"))
);
assert.equal(typeof headless.QueueController, "function");
assert.equal(typeof headless.DeliveryQueue, "function");
assert.equal(typeof protocol.readQueueRequest, "function");
const mobileRequire = createRequire(join(root, "apps/mobile/package.json"));
const webRequire = createRequire(join(root, "apps/web/package.json"));
assert.equal(mobileRequire("react/package.json").version, pkg.overrides.react);
assert.equal(webRequire("react/package.json").version, pkg.overrides.react);
assert.equal(
  mobileRequire("react-native/package.json").version,
  read("apps/mobile/package.json").dependencies["react-native"],
);
assert.throws(() => desktopRequire.resolve("react-native"), { code: "MODULE_NOT_FOUND" });
const metro = mobileRequire("./metro.config.js");
const context = { originModulePath: join(root, "packages/chat-ui/src/markdown.native.tsx") };
for (const platform of ["ios", "android"]) {
  for (const name of ["react", "react/jsx-runtime", "react-native"]) {
    assert.equal(
      metro.resolver.resolveRequest(context, name, platform).filePath,
      mobileRequire.resolve(name),
    );
    assert(
      [metro.projectRoot, ...(metro.watchFolders || [])].some((folder) => {
        const location = relative(folder, mobileRequire.resolve(name));
        return location.split(sep)[0] !== ".." && !isAbsolute(location);
      }),
      `Pinned ${name} must be watched by Metro.`,
    );
  }
}
const workletRoot = mkdtempSync(join(tmpdir(), "rakazo-worklet-check-"));
try {
  const filename = join(workletRoot, "fixture.js");
  const source = 'function fixture() { "worklet"; return 42; }';
  writeFileSync(filename, source);
  const worklet = mobileRequire("@babel/core").transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    plugins: [mobileRequire.resolve("react-native-worklets/plugin")],
  });
  assert(
    worklet.code.includes("__workletHash"),
    "The isolated Worklets Babel plugin must compile.",
  );
} finally {
  rmSync(workletRoot, { recursive: true, force: true });
}
// Pi's root export is ESM-only; resolve it as a consumer in the declaring workspace.
execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `
  import assert from "node:assert/strict";
  import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
  assert.equal(typeof createAgentSession, "function");
  assert.equal(typeof SessionManager, "function");
  assert.equal(process.versions.bun, undefined);
`,
  ],
  { cwd: join(root, "packages/pi-kit"), stdio: "pipe" },
);
console.log(
  `Workspace install: ${paths.size} workspaces, ${links} links; signing patch, Node queue imports and native isolation verified.`,
);
