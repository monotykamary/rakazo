import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Developer-only snapshot refresh. Runtime installation never needs sibling checkouts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["pi-fabric", "pi-fovea", "pi-queue-steer", "pi-retry", "pi-multiprovider"];
const destination = resolve(root, "vendor/pi-kit");
const kitManifestPath = resolve(root, "packages/pi-kit/package.json");
const manifest = JSON.parse(readFileSync(kitManifestPath, "utf8"));
const consumers = ["packages/core/package.json", "packages/adapters/package.json"].map((path) => ({
  path: resolve(root, path),
  manifest: JSON.parse(readFileSync(resolve(root, path), "utf8")),
}));
const staging = mkdtempSync(resolve(tmpdir(), "rakazo-kit-pack-"));
const records = [];
try {
  for (const source of sources) {
    const cwd = resolve(root, "..", source);
    const packageManifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
    // Builds and tests must be run before this command; never let pack trigger an implicit build.
    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", staging],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const [packed] = JSON.parse(output);
    for (const file of packed.files) {
      if (
        /(^|\/)(\.env(?:\..*)?|auth\.json|models\.json|settings\.json|.*\.(?:pem|key|p12|pfx))$/.test(
          file.path,
        ) ||
        /(^|\/)(\.git|node_modules|sessions)(\/|$)/.test(file.path)
      ) {
        throw new Error(`Refusing a sensitive or runtime-state package entry: ${source}`);
      }
    }
    const bytes = readFileSync(resolve(staging, packed.filename));
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
    renameSync(resolve(staging, packed.filename), resolve(staging, filename));
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
  writeFileSync(
    resolve(destination, "manifest.json"),
    `${JSON.stringify({ version: 1, packages: records }, null, 2)}\n`,
  );
  writeFileSync(kitManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const consumer of consumers)
    writeFileSync(consumer.path, `${JSON.stringify(consumer.manifest, null, 2)}\n`);
  console.log(
    `Snapshotted ${records.length} extension packages. Update the lockfile and run kit verification before shipping.`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
