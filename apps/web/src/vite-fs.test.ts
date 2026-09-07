import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isFileLoadingAllowed, normalizePath, resolveConfig } from "vite";
import { expect, test } from "vitest";

test("dev allows resolved Geist assets without opening the dependency cache", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const cwd = process.cwd();
  const config = await (async () => {
    try {
      process.chdir(root);
      return await resolveConfig({ root, configFile: path.join(root, "vite.config.ts") }, "serve");
    } finally {
      process.chdir(cwd);
    }
  })();
  const cssPath = realpathSync(
    createRequire(path.join(root, "package.json")).resolve("@fontsource-variable/geist/wght.css"),
  );
  const fontRoot = path.join(path.dirname(cssPath), "files");
  expect(config.server.fs.strict).toBe(true);
  expect(config.server.fs.allow).toEqual([
    normalizePath(path.resolve(root, "../..")),
    normalizePath(fontRoot),
  ]);
  const assets = [
    ...readFileSync(cssPath, "utf8").matchAll(/url\((?:['"])?(\.\/files\/[^)'"\s]+\.woff2)/g),
  ];
  expect(assets.length).toBeGreaterThan(0);
  for (const [, asset] of assets) {
    const file = realpathSync(path.resolve(path.dirname(cssPath), asset!));
    expect(isFileLoadingAllowed(config, normalizePath(file))).toBe(true);
    expect(readFileSync(file).subarray(0, 4).toString()).toBe("wOF2");
  }
  const outside = path.resolve(root, "../../..");
  expect(isFileLoadingAllowed(config, normalizePath(path.join(outside, "unrelated.woff2")))).toBe(
    false,
  );
  if (!normalizePath(cssPath).startsWith(`${normalizePath(path.resolve(root, "../.."))}/`)) {
    expect(isFileLoadingAllowed(config, normalizePath(cssPath))).toBe(false);
    expect(
      isFileLoadingAllowed(
        config,
        normalizePath(path.join(path.dirname(fontRoot), "other", "secret.woff2")),
      ),
    ).toBe(false);
  }
  expect(isFileLoadingAllowed(config, normalizePath(path.join(fontRoot, ".env")))).toBe(false);
});
