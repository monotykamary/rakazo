import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Developer-only snapshot refresh. Runtime installation never needs sibling checkouts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allSources = [
  "pi-fabric",
  "pi-fovea",
  "pi-queue-steer",
  "pi-retry",
  "pi-multiprovider",
  "pi-hide-providers",
];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--only" || !allSources.includes(args[1]))) {
  throw new Error(`Usage: vendor-pi-kit.mjs [--only ${allSources.join("|")}]`);
}
const sources = args.length ? [args[1]] : allSources;
const destination = resolve(root, "vendor/pi-kit");
const kitManifestPath = resolve(root, "packages/pi-kit/package.json");
const manifest = JSON.parse(readFileSync(kitManifestPath, "utf8"));
const consumers = ["packages/core/package.json", "packages/adapters/package.json"].map((path) => ({
  path: resolve(root, path),
  manifest: JSON.parse(readFileSync(resolve(root, path), "utf8")),
}));
const artifactManifestPath = resolve(destination, "manifest.json");
const previous = JSON.parse(readFileSync(artifactManifestPath, "utf8"));
const staging = mkdtempSync(resolve(tmpdir(), "rakazo-kit-pack-"));
const records = [];
try {
  for (const source of sources) {
    const cwd = resolve(root, "..", source);
    const packageManifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
    // Builds and tests must be run before this command; never let pack trigger an implicit build.
    const archivePath = resolve(staging, "snapshot.tgz");
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archivePath, "--quiet"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const files = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .trim()
      .split("\n");
    for (const file of files) {
      if (
        /(^|\/)(\.env(?:\..*)?|auth\.json|models\.json|settings\.json|.*\.(?:pem|key|p12|pfx))$/.test(
          file,
        ) ||
        /(^|\/)(\.git|node_modules|sessions)(\/|$)/.test(file)
      ) {
        throw new Error(`Refusing a sensitive or runtime-state package entry: ${source}`);
      }
    }
    const bytes = readFileSync(archivePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = `${packageManifest.name.replaceAll("@", "").replaceAll("/", "-")}-${packageManifest.version}-${sha256.slice(0, 12)}.tgz`;
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    records.push({
      name: packageManifest.name,
      version: packageManifest.version,
      filename,
      sha256,
      baseCommit,
    });
    renameSync(archivePath, resolve(staging, filename));
    const dependency = `file:../../vendor/pi-kit/${filename}`;
    manifest.dependencies[packageManifest.name] = dependency;
    for (const consumer of consumers) {
      if (consumer.manifest.dependencies?.[packageManifest.name])
        consumer.manifest.dependencies[packageManifest.name] = dependency;
    }
  }
  mkdirSync(destination, { recursive: true });
  for (const record of records)
    renameSync(resolve(staging, record.filename), resolve(destination, record.filename));
  // A targeted refresh must preserve every unselected archive identity and hash.
  const replacements = new Map(records.map((record) => [record.name, record]));
  const packages = previous.packages.map((record) => replacements.get(record.name) ?? record);
  for (const record of records) {
    if (!packages.some((entry) => entry.name === record.name)) packages.push(record);
  }
  writeFileSync(artifactManifestPath, `${JSON.stringify({ version: 1, packages }, null, 2)}\n`);
  writeFileSync(kitManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const consumer of consumers) {
    const content = `${JSON.stringify(consumer.manifest, null, 2)}\n`;
    if (readFileSync(consumer.path, "utf8") !== content) writeFileSync(consumer.path, content);
  }
  console.log(
    `Snapshotted ${records.length} extension packages. Update the lockfile and run kit verification before shipping.`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
