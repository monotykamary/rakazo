import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { resolveTypeScriptSource } = require("../metro-resolver.js") as {
  resolveTypeScriptSource: (
    context: { originModulePath?: string },
    moduleName: string,
    platform: string,
    resolveRequest: (
      context: { originModulePath?: string },
      moduleName: string,
      platform: string,
    ) => unknown,
  ) => unknown;
};

const { getDependencyRoots, resolveLinkedDependencies } = require("../metro-resolver.js");

describe("linked native dependencies", () => {
  function fixture(run: (app: string, native: string, lists: string) => void) {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "metro-links-")));
    const app = join(temp, "checkout", "mobile");
    const native = join(temp, "cache", "native", "node_modules", "react-native");
    const lists = join(
      temp,
      "cache",
      "lists",
      "node_modules",
      "@react-native",
      "virtualized-lists",
    );
    function pkg(root: string, manifest: object) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    }
    function link(from: string, name: string, target: string) {
      const path = join(from, "node_modules", name);
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(target, path, "dir");
    }
    pkg(app, {});
    pkg(native, {
      dependencies: { "@react-native/virtualized-lists": "1" },
      optionalDependencies: { "missing-platform-package": "1" },
      devDependencies: { "not-installed-dev": "1" },
      peerDependencies: { "not-installed-peer": "1" },
    });
    pkg(lists, { exports: { ".": "./index.js" }, dependencies: { "react-native": "1" } });
    link(app, "react-native", native);
    // Sibling links, as in Bun's isolated global cache, not nested packages.
    link(dirname(dirname(native)), "@react-native/virtualized-lists", lists);
    link(dirname(dirname(dirname(lists))), "react-native", native);
    try {
      run(app, native, lists);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  it("watches only exact transitive roots, handling cycles and hidden manifests", () => {
    fixture((app, native, lists) => {
      expect(getDependencyRoots(app, ["react-native"])).toEqual([native, lists]);
      expect(() => getDependencyRoots(app, ["missing-required"])).toThrow(
        "Cannot locate Metro dependency",
      );
    });
  });

  it.each(["ios", "android"])("delegates linked subpaths to Metro on %s", (platform) => {
    fixture((app, native, lists) => {
      const context = { originModulePath: join(native, "Libraries", "FlatList.js") };
      const result = { type: "sourceFile", filePath: join(lists, `index.${platform}.js`) };
      const resolve = vi.fn(() => result);
      const name = "@react-native/virtualized-lists/subpath";
      expect(
        resolveLinkedDependencies(
          context,
          name,
          platform,
          getDependencyRoots(app, ["react-native"]),
          resolve,
        ),
      ).toBe(result);
      expect(resolve).toHaveBeenCalledWith(
        {
          ...context,
          disableHierarchicalLookup: true,
          nodeModulesPaths: [],
          extraNodeModules: { "@react-native/virtualized-lists": lists },
        },
        name,
        platform,
      );
    });
  });

  it("does not redirect workspace, relative, or unwatched dependency imports", () => {
    fixture((app, native, lists) => {
      for (const [origin, name, roots] of [
        [join(app, "index.ts"), "react-native", [native, lists]],
        [join(`${native}-other`, "index.js"), "react-native", [native, lists]],
        [join(native, "index.js"), "./helper.js", [native, lists]],
        [join(native, "index.js"), "@react-native/virtualized-lists", [native]],
      ] as const) {
        const context = { originModulePath: origin };
        const resolve = vi.fn();
        resolveLinkedDependencies(context, name, "ios", roots, resolve);
        expect(resolve).toHaveBeenCalledWith(context, name, "ios");
        expect(resolve.mock.calls[0]?.[0]).toBe(context);
      }
    });
  });
});

describe("mobile Metro resolver", () => {
  it("resolves Node ESM-style JavaScript specifiers to TypeScript source", () => {
    const resolved = { type: "sourceFile", filePath: "/repo/packages/core/src/async.ts" };
    const resolveRequest = vi.fn((_context, moduleName: string) => {
      if (moduleName === "./async") return resolved;
      throw new Error(`Unexpected module: ${moduleName}`);
    });

    expect(
      resolveTypeScriptSource(
        { originModulePath: "/repo/packages/core/src/index.ts" },
        "./async.js",
        "ios",
        resolveRequest,
      ),
    ).toEqual(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(
      { originModulePath: "/repo/packages/core/src/index.ts" },
      "./async",
      "ios",
    );
  });

  it("keeps ordinary JavaScript imports on Metro's normal path", () => {
    const resolved = { type: "sourceFile", filePath: "/repo/app/helper.js" };
    const resolveRequest = vi.fn(() => resolved);
    const context = { originModulePath: "/repo/app/index.js" };

    expect(resolveTypeScriptSource(context, "./helper.js", "ios", resolveRequest)).toEqual(
      resolved,
    );
    expect(resolveRequest).toHaveBeenCalledOnce();
    expect(resolveRequest).toHaveBeenCalledWith(context, "./helper.js", "ios");
  });
});
