const { realpathSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, sep } = require("node:path");

function resolveLinkedDependencies(context, moduleName, platform, roots, resolveRequest) {
  const importer = context.originModulePath || "";
  if (
    !moduleName.startsWith(".") &&
    !moduleName.startsWith("/") &&
    roots.some((root) => importer.startsWith(root + sep))
  ) {
    const name = moduleName.startsWith("@")
      ? moduleName.split("/").slice(0, 2).join("/")
      : moduleName.split("/")[0];
    const localRequire = createRequire(importer);
    for (const modules of localRequire.resolve.paths(name) || []) {
      let root;
      try {
        root = realpathSync(join(modules, name));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        continue;
      }
      if (roots.includes(root)) {
        // The link's parent is deliberately not watched. Give Metro the exact
        // package root, retaining exports, platform extensions and main fields.
        return resolveRequest(
          {
            ...context,
            disableHierarchicalLookup: true,
            nodeModulesPaths: [],
            extraNodeModules: { ...context.extraNodeModules, [name]: root },
          },
          moduleName,
          platform,
        );
      }
      break;
    }
  }
  return resolveRequest(context, moduleName, platform);
}

function getDependencyRoots(projectRoot, packageNames) {
  const roots = new Set();

  function visit(from, name, optional = false) {
    const localRequire = createRequire(join(from, "package.json"));
    let manifest;
    // Resolve the manifest without package exports: some dependencies hide it.
    for (const modules of localRequire.resolve.paths(name) || []) {
      try {
        manifest = realpathSync(join(modules, name, "package.json"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    if (!manifest) {
      if (optional) return;
      throw new Error(`Cannot locate Metro dependency ${name} from ${from}`);
    }
    const root = dirname(manifest);
    if (roots.has(root)) return;
    roots.add(root);
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const optionalDependencies = pkg.optionalDependencies || {};
    for (const dependency of Object.keys({ ...pkg.dependencies, ...optionalDependencies })) {
      visit(root, dependency, Object.hasOwn(optionalDependencies, dependency));
    }
  }

  for (const name of packageNames) visit(projectRoot, name);
  return [...roots];
}

function resolveTypeScriptSource(context, moduleName, platform, resolveRequest) {
  const importer = context.originModulePath ?? "";
  const isTypeScriptImporter = /\.[cm]?tsx?$/.test(importer);

  if (isTypeScriptImporter && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Preserve Metro's normal resolution and error for real JavaScript imports.
    }
  }

  return resolveRequest(context, moduleName, platform);
}

module.exports = { getDependencyRoots, resolveLinkedDependencies, resolveTypeScriptSource };
