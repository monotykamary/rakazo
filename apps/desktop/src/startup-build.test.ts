import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

// Do not launch Electron: this probes the production Node ESM import graph with
// only Electron's native API replaced. Vitest's TS resolver would hide missing
// workspace JavaScript, and a real Electron launch would open windows on macOS.
const electronStub = `
  export const app = {
    isPackaged: false,
    getVersion: () => "0.0.0",
    setPath() {},
    once() {},
    on() {},
    whenReady() {
      console.log("desktop-ready-handler-registered");
      return new Promise(() => {});
    },
  };
  export class BrowserWindow {
    constructor() { throw new Error("The import probe must not open a window"); }
  }
  export const ipcMain = {}, Menu = {}, net = {}, session = {}, shell = {};
`;

const loader = `
  import { registerHooks } from "node:module";
  const stub = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(electronStub)}`)};
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "electron"
        ? { url: stub, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
`;

describe("desktop production startup", () => {
  it("loads the shipped entry in native Node without a TypeScript resolver", () => {
    const build = spawnSync("bun", ["run", "build"], { cwd: root, encoding: "utf8" });
    expect(build.error).toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);

    const metadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      main: string;
    };
    const entry = pathToFileURL(path.join(root, metadata.main)).href;
    const probe = spawnSync(
      "node",
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(loader)}`,
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(entry)});`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stdout + probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("desktop-ready-handler-registered");
  });
});
