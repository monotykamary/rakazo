import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const [major, minor] = process.versions.node.split(".").map(Number);
assert(
  !process.versions.bun && ((major === 24 && minor >= 11) || major >= 26),
  "Install with Node 24.11+ LTS or 26+ available on PATH.",
);
const version = pkg.packageManager.slice("bun@".length);
assert(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Install lifecycle, not a cached Turbo task.
  process.env.npm_config_user_agent?.startsWith(`bun/${version} `),
  `Install with Bun ${version}.`,
);
