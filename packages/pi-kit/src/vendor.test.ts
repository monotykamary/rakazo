import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/vendor-pi-kit.mjs", import.meta.url));
describe("kit refresh options", () => {
  it.each([
    ["--source-root"],
    ["--only", "unknown"],
    ["--unknown", "value"],
    ["--source-root", "--only"],
    ["--only", "pi-fovea", "--only", "pi-retry"],
  ])("rejects malformed options before packing %j", (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: vendor-pi-kit.mjs");
  });
});
