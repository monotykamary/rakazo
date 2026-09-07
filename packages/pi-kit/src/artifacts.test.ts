import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_KIT_PACKAGES } from "./index.js";

const root = new URL("../../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("vendor/pi-kit/manifest.json", root), "utf8")) as {
  version: number;
  packages: Array<{ name: string; version: string; filename: string; sha256: string }>;
};

describe("distributable kit artifacts", () => {
  it("contains exactly the reviewed kit with matching content hashes", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.packages.map((entry) => entry.name).sort()).toEqual(
      PI_KIT_PACKAGES.map((entry) => entry.name).sort(),
    );
    for (const entry of manifest.packages) {
      const archive = new URL(`vendor/pi-kit/${entry.filename}`, root);
      expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(entry.sha256);
      const files = execFileSync("tar", ["-tzf", fileURLToPath(archive)], { encoding: "utf8" })
        .trim()
        .split("\n");
      const specification = PI_KIT_PACKAGES.find((item) => item.name === entry.name)!;
      expect(entry.version).toBe(specification.version);
      for (const extension of specification.extensions)
        expect(files).toContain(`package/${extension}`);
      expect(
        files.some((name) =>
          /(^|\/)(\.env|auth\.json|multiprovider-auth\.json|node_modules|sessions)(\/|$)/.test(
            name,
          ),
        ),
      ).toBe(false);
    }
  });
  it("ships queue control exports without relying on a sibling checkout", () => {
    const entry = manifest.packages.find((item) => item.name === "pi-queue-steer-factory")!;
    const archive = fileURLToPath(new URL(`vendor/pi-kit/${entry.filename}`, root));
    const packed = JSON.parse(
      execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    expect(packed.exports["./headless"].import).toBe("./dist/headless.js");
    expect(packed.exports["./protocol"].import).toBe("./dist/protocol.js");
    expect(
      Object.values(packed.dependencies ?? {}).some((value) => String(value).startsWith("link:")),
    ).toBe(false);
  });
});
