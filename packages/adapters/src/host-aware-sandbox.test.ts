import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createRunSandbox, HostAwareSandbox, sandboxKindForBot } from "./host-aware-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("host-aware sandbox", () => {
  const hostRoot = mkdtempSync(path.join(tmpdir(), "rakazo-host-root-"));
  const localProject = mkdtempSync(path.join(tmpdir(), "rakazo-local-project-"));
  const localData = mkdtempSync(path.join(tmpdir(), "rakazo-local-data-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(localProject, { recursive: true, force: true });
    rmSync(localData, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("exposes and routes page commands through the production Docker wrapper", async () => {
    const result = {
      ok: true,
      url: "https://example.test",
      title: "Page",
      tree: "Page",
      elements: [],
    };
    const pageBrowser = vi
      .spyOn(DockerSandboxProvider.prototype, "pageBrowser")
      .mockResolvedValue(result);
    const sandbox = createRunSandbox("docker", {
      prisma: { deploymentSettings: { findUnique: vi.fn() } } as unknown as PrismaClient,
    });
    const browser = new ComputerBrowserProvider({ sandbox });
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "docker",
    };
    expect(browser.describe().capabilities.page).toBe(true);
    expect(await browser.snapshot(computer, {}, ctx)).toMatchObject({
      title: "Page",
      tree: "Page",
    });
    expect(pageBrowser).toHaveBeenCalledWith(computer, { command: "snapshot" }, ctx);

    pageBrowser.mockClear();
    const hostResult = await browser.snapshot({ ...computer, kind: "desktop" }, {}, ctx);
    expect(hostResult.fallback).toBe("computer_act");
    expect(pageBrowser).not.toHaveBeenCalled();
  });

  it("does not expose page commands when neither provider supports them", () => {
    const sandbox = new HostAwareSandbox(
      new FakeSandboxProvider(),
      new DesktopSandboxProvider(),
      async () => false,
    );
    expect(sandbox.pageBrowser).toBeUndefined();
  });

  it("lets this-mac cwd run under a host root", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "host", homePath: "/tmp/host-home" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: hostRoot },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("still refuses paths outside home and host roots", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "deny", homePath: "/tmp/deny" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/outside this computer's home/i);
    await desktop.destroy(computer, ctx);
  });

  it("provisions on the host provider when enabled", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => true);
    const computer = await sandbox.provision({ botId: "switch", homePath: "/tmp/switch" }, ctx);
    expect(computer.kind).toBe("desktop");
    await sandbox.destroy(computer, ctx);
  });

  it("provisions on the isolated provider when this-mac is off", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "iso", homePath: "/tmp/iso" }, ctx);
    expect(computer.kind).toBe("fake");
    await sandbox.destroy(computer, ctx);
  });

  it("maps the Linux bot home cwd onto the desktop home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "alias", homePath: "/tmp/alias" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: "/home/rakazo" },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("binds product file tools to local Pi cwd without importing, exporting, or marking it", async () => {
    const sandbox = createRunSandbox("desktop", {
      dataDir: localData,
      trustedWorkspaceRoot: localProject,
    });
    const computer = await sandbox.provision(
      {
        botId: "local-bot",
        homePath: "/unused",
        providerRef: path.join(localData, "desktop-computers", "local-bot"),
        providerKind: "desktop",
      },
      ctx,
    );

    expect(computer).toMatchObject({
      botId: "local-bot",
      kind: "desktop",
      providerRef: realpathSync(localProject),
      fresh: false,
    });
    expect(sandbox.describe().capabilities).toMatchObject({ graphical: false, snapshots: false });

    await sandbox.writeFile(
      computer,
      {
        path: "native.txt",
        content: new TextEncoder().encode("written through product tools"),
      },
      ctx,
    );
    expect(readFileSync(path.join(localProject, "native.txt"), "utf8")).toBe(
      "written through product tools",
    );
    expect(new TextDecoder().decode(await sandbox.readFile(computer, "native.txt", ctx))).toBe(
      "written through product tools",
    );

    const exported = [];
    for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file);
    expect(exported).toEqual([]);
    await sandbox.importWorkspace(
      computer,
      (async function* () {
        yield { path: "restored.txt", content: new TextEncoder().encode("must not appear") };
      })(),
      ctx,
    );
    expect(existsSync(path.join(localProject, "restored.txt"))).toBe(false);

    await sandbox.stop(computer, ctx);
    await sandbox.destroy(computer, ctx);
    expect(existsSync(localProject)).toBe(true);
    expect(existsSync(path.join(localProject, "native.txt"))).toBe(true);
    expect(existsSync(path.join(localProject, ".stopped"))).toBe(false);
  });

  it("only switches docker deployments onto this Mac", () => {
    expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
    expect(sandboxKindForBot("docker", "docker")).toBe("docker");
    expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
    expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
  });

  it("forwards pageBrowser to the routed provider", async () => {
    const isolated: SandboxProvider = new FakeSandboxProvider();
    const calls: unknown[] = [];
    isolated.pageBrowser = async (computer, request, context) => {
      calls.push({ computerId: computer.id, request, aborted: context.signal.aborted });
      return { ok: true, url: "https://example.test", title: "Example", tree: "", elements: [] };
    };
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "page", homePath: "/tmp/page" }, ctx);
    expect(typeof sandbox.pageBrowser).toBe("function");
    await expect(
      sandbox.pageBrowser!(computer, { command: "snapshot" }, ctx),
    ).resolves.toMatchObject({
      ok: true,
      url: "https://example.test",
    });
    expect(calls).toEqual([
      { computerId: computer.id, request: { command: "snapshot" }, aborted: false },
    ]);
    await sandbox.destroy(computer, ctx);
  });
});
