import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  prepareBrowserProfileCommand,
  stopScreensCommand,
} from "./supervisor-logic.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const shared = path.join(home, ".browser-profiles/chromium");
  mkdirSync(shared, { recursive: true });
  mkdirSync(runtime);
  const profile = (bot: string) => browserProfilePathForScreen(bot).replace("/home/rakazo", home);
  const run = (script: string) => {
    // GNU cp's reflink optimization has no macOS equivalent; all copy semantics remain intact.
    const portable =
      process.platform === "darwin" ? script.replaceAll(" --reflink=auto", "") : script;
    return spawnSync(
      "bash",
      ["-eu", "-c", portable.replaceAll("/tmp/rakazo", runtime).replaceAll("/home/rakazo", home)],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  };
  return { shared, profile, run, runtime };
}

describe("durable independent browser profiles", () => {
  it.each([false, true])("restores tabs with the selected profile (explicit: %s)", (explicit) => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-browser-argv-"));
    fixtures.push(root);
    const profile = path.join(root, "profile with spaces");
    writeFileSync(path.join(root, "chromium"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const wrapper = fileURLToPath(new URL("../../computer/rakazo-browser", import.meta.url));
    const args = explicit ? ["--user-data-dir", profile] : [];
    const result = spawnSync("sh", [wrapper, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: root,
        PATH: `${root}:${process.env.PATH}`,
        DISPLAY: ":2",
        RAKAZO_BROWSER_PROFILE: profile,
      },
    });
    expect(result.status).toBe(0);
    const argv = result.stdout.trim().split("\n");
    expect(argv).toContain("--restore-last-session");
    expect(argv).toContain("--remote-debugging-address=127.0.0.1");
    expect(argv).toContain("--remote-debugging-port=9223");
    expect(argv).toContain(explicit ? profile : `--user-data-dir=${profile}`);
  });
  it("keeps both bots' data through stop and restart without copying the default profile", () => {
    const { shared, profile, run } = fixture();
    writeFileSync(path.join(shared, "login"), "legacy-session");
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(existsSync(path.join(profile(bot), "login"))).toBe(false);
      writeFileSync(path.join(profile(bot), "login"), `${bot}-session`);
    }
    expect(
      run(
        stopScreensCommand([
          { screenId: "writer", index: 0 },
          { screenId: "reader", index: 1 },
        ]),
      ).status,
    ).toBe(0);
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(readFileSync(path.join(profile(bot), "login"), "utf8")).toBe(`${bot}-session`);
    }
    expect(run(prepareBrowserProfileCommand("new-bot")).status).toBe(0);
    expect(existsSync(path.join(profile("new-bot"), "login"))).toBe(false);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("legacy-session");
  });
});
