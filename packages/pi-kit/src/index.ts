import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_RUNTIME_VERSION = "0.85.1";

/** Reviewed together; never resolve floating extension versions at session startup. */
export const PI_KIT_PACKAGES = [
  { name: "pi-fabric", version: "0.90.1", entry: "pi-fabric", extensions: ["dist/index.js"] },
  { name: "pi-fovea", version: "0.22.1", entry: "pi-fovea/ops", extensions: ["src/index.ts"] },
  {
    name: "pi-queue-steer-factory",
    version: "0.17.1",
    entry: "pi-queue-steer-factory/headless",
    extensions: ["index.ts"],
  },
  {
    name: "@monotykamary/pi-retry",
    version: "0.8.6",
    entry: "@monotykamary/pi-retry/package.json",
    extensions: ["retry.ts"],
  },
  {
    name: "pi-multiprovider",
    version: "0.2.10",
    entry: "pi-multiprovider",
    extensions: ["extensions/multiprovider.ts"],
  },
  {
    name: "pi-hide-providers",
    version: "0.1.18",
    entry: "pi-hide-providers/package.json",
    extensions: ["hide-providers.ts"],
  },
] as const;

export interface PiKitInstallation {
  runtimeVersion: string;
  cli: string;
  extensionPaths: string[];
  packages: Array<{ name: string; version: string }>;
}

function packageRoot(entry: string, name: string): string {
  let directory = dirname(entry);
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      if (
        manifest &&
        typeof manifest === "object" &&
        "name" in manifest &&
        manifest.name === name
      ) {
        return directory;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Pi kit package manifest unavailable: ${name}`);
    directory = parent;
  }
}

/** Validate package identity and every extension before a worker can start. */
export function validatePiKitPackage(
  root: string,
  expected: { name: string; version: string; extensions: readonly string[] },
): string[] {
  const canonicalRoot = realpathSync(root);
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(canonicalRoot, "package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    !("version" in manifest) ||
    manifest.name !== expected.name ||
    manifest.version !== expected.version
  ) {
    throw new Error(`Pi kit version mismatch: ${expected.name}@${expected.version}`);
  }
  return expected.extensions.map((entry) => {
    const path = realpathSync(resolve(canonicalRoot, entry));
    const within = relative(canonicalRoot, path);
    if (
      within === ".." ||
      within.startsWith("../") ||
      within.startsWith("..\\") ||
      isAbsolute(within) ||
      !statSync(path).isFile()
    ) {
      throw new Error(`Pi kit entry escapes its package or is not a file: ${expected.name}`);
    }
    return path;
  });
}

export function resolvePiKit(): PiKitInstallation {
  const resolveEntry = (entry: string) => fileURLToPath(import.meta.resolve(entry));
  const runtimeRoot = packageRoot(
    resolveEntry("@earendil-works/pi-coding-agent"),
    "@earendil-works/pi-coding-agent",
  );
  const [cli] = validatePiKitPackage(runtimeRoot, {
    name: "@earendil-works/pi-coding-agent",
    version: PI_RUNTIME_VERSION,
    extensions: ["dist/bundle/cli.js"],
  });
  const extensionPaths = PI_KIT_PACKAGES.flatMap((spec) =>
    validatePiKitPackage(packageRoot(resolveEntry(spec.entry), spec.name), spec),
  );
  return {
    runtimeVersion: PI_RUNTIME_VERSION,
    cli: cli!,
    extensionPaths,
    packages: PI_KIT_PACKAGES.map(({ name, version }) => ({ name, version })),
  };
}
