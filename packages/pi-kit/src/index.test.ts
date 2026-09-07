import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_KIT_PACKAGES, PI_RUNTIME_VERSION, validatePiKitPackage } from "./index.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rakazo-kit-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "test-extension", version: "1.0.0" }),
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.js"), "export default () => {};\n");
  return root;
}
const expected = { name: "test-extension", version: "1.0.0", extensions: ["dist/index.js"] };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed Pi kit", () => {
  it("pins all six extensions and the runtime", () => {
    expect(PI_KIT_PACKAGES).toHaveLength(6);
    for (const { version } of PI_KIT_PACKAGES) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PI_RUNTIME_VERSION).toBe("0.85.1");
  });
  it("validates extension files before returning an installation", () => {
    expect(validatePiKitPackage(fixture(), expected)[0]).toMatch(/dist[/\\]index\.js$/);
  });
  it("rejects a mismatched version or package identity", () => {
    const root = fixture();
    expect(() => validatePiKitPackage(root, { ...expected, version: "2.0.0" })).toThrow(
      "version mismatch",
    );
    expect(() => validatePiKitPackage(root, { ...expected, name: "other" })).toThrow(
      "version mismatch",
    );
  });
  it("rejects missing files and directories", () => {
    const root = fixture();
    expect(() => validatePiKitPackage(root, { ...expected, extensions: ["missing.js"] })).toThrow();
    expect(() => validatePiKitPackage(root, { ...expected, extensions: ["dist"] })).toThrow(
      "not a file",
    );
  });
  it("rejects symlink escapes from a package", () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(join(outside, "dist/index.js"), join(root, "escape.js"));
    expect(() => validatePiKitPackage(root, { ...expected, extensions: ["escape.js"] })).toThrow(
      "escapes",
    );
  });
});
