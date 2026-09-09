const { getDefaultConfig } = require("expo/metro-config");
const {
  getDependencyRoots,
  resolveLinkedDependencies,
  resolveTypeScriptSource,
} = require("./metro-resolver");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
// Bun global links can put pinned packages and their dependencies outside the
// checkout. Watch exact package roots so Metro can resolve and hash their files.
const dependencyRoots = getDependencyRoots(projectRoot, ["react", "react-native"]);
config.watchFolders = [...new Set([...(config.watchFolders || []), ...dependencyRoots])];
const defaultResolveRequest = config.resolver.resolveRequest;
const pinned = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-native"]);

function resolveFromApp(moduleName) {
  return require.resolve(moduleName, { paths: [projectRoot] });
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (pinned.has(moduleName) || moduleName.startsWith("react-native/")) {
    try {
      return { type: "sourceFile", filePath: resolveFromApp(moduleName) };
    } catch {
      // Fall through to Metro if this exact subpath is not in the app tree.
    }
  }
  return resolveLinkedDependencies(
    context,
    moduleName,
    platform,
    dependencyRoots,
    (linkedContext, name, target) =>
      resolveTypeScriptSource(
        linkedContext,
        name,
        target,
        defaultResolveRequest || context.resolveRequest,
      ),
  );
};

module.exports = config;
