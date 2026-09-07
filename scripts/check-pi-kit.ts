import { resolvePiKit } from "../packages/pi-kit/src/index.js";

const kit = resolvePiKit();
console.log(
  JSON.stringify({
    runtimeVersion: kit.runtimeVersion,
    extensions: kit.extensionPaths.length,
    packages: kit.packages,
  }),
);
