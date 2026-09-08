import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  credentialsPath,
  loadCredentials,
  normalizeServerUrl,
  runnerHomeFromEnv,
  saveCredentials,
} from "./credentials.js";

const home = path.join(os.tmpdir(), "rakazo-runner-credentials-test");

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("runner credentials", () => {
  it("round-trips credentials through a 0600 file in a 0700 home", async () => {
    await saveCredentials(home, {
      serverUrl: "https://rakazo.example",
      machineId: "mach1",
      machineToken: "rk_m_abcdefghijklmnopqrstuvwxyz0123456789abcdef",
      name: "laptop",
    });
    const fileStat = await stat(credentialsPath(home));
    expect(fileStat.mode & 0o777).toBe(0o600);
    const homeStat = await stat(home);
    expect(homeStat.mode & 0o777).toBe(0o700);
    expect(await loadCredentials(home)).toMatchObject({
      serverUrl: "https://rakazo.example",
      machineId: "mach1",
      name: "laptop",
    });
  });

  it("tightens a pre-existing wide-open home directory", async () => {
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755);
    await saveCredentials(home, {
      serverUrl: "https://rakazo.example",
      machineId: "mach1",
      machineToken: "rk_m_abcdefghijklmnopqrstuvwxyz0123456789abcdef",
    });
    expect((await stat(home)).mode & 0o077).toBe(0);
  });

  it("refuses to persist invalid pairing results", async () => {
    await expect(
      saveCredentials(home, {
        serverUrl: "https://rakazo.example",
        machineId: "mach1",
        machineToken: "not-a-token",
      }),
    ).rejects.toThrow(/machine token/i);
    await expect(loadCredentials(home)).rejects.toThrow(/not paired/i);
  });

  it("rejects server URLs that are not bare origins", () => {
    expect(normalizeServerUrl("https://rakazo.example/")).toBe("https://rakazo.example");
    expect(() => normalizeServerUrl("https://user@rakazo.example")).toThrow(/credentials/i);
    expect(() => normalizeServerUrl("https://rakazo.example/api/machines/runner/poll")).toThrow(
      /origin/i,
    );
    expect(() => normalizeServerUrl("file:///etc")).toThrow(/https/i);
  });

  it("resolves the runner home from the environment", () => {
    expect(runnerHomeFromEnv({ RAKAZO_RUNNER_HOME: "/srv/rakazo-runner" })).toBe(
      "/srv/rakazo-runner",
    );
    expect(runnerHomeFromEnv({})).toMatch(/rakazo-runner$/);
  });

  it("fails loudly on a corrupted credential file", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "credentials.json"), '{"machineId": 1}', "utf8");
    await expect(loadCredentials(home)).rejects.toThrow(/machineId|token|serverUrl/);
  });

  it("keeps the token out of a replaced file after re-pairing", async () => {
    await saveCredentials(home, {
      serverUrl: "https://rakazo.example",
      machineId: "mach1",
      machineToken: "rk_m_abcdefghijklmnopqrstuvwxyz0123456789abcdef",
    });
    await saveCredentials(home, {
      serverUrl: "https://rakazo.example",
      machineId: "mach1",
      machineToken: "rk_m_zyxwvutsrqponmlkjihgfedcba9876543210abcde",
    });
    const text = await readFile(credentialsPath(home), "utf8");
    expect(text.match(/rk_m_/g)).toHaveLength(1);
  });
});
