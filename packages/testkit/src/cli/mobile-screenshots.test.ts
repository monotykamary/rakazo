import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({
  ComposioEmulator: vi.fn(),
  EmailEmulator: vi.fn(),
  PipedreamConnector: vi.fn(),
  ThirdPartyConnectorEmulator: vi.fn(),
}));
vi.mock("@rakazo/db", () => ({ createThreadMessage: vi.fn() }));
vi.mock("../index.js", () => ({ sessionCookieHeader: vi.fn() }));

import { startDeviceControlServer } from "./mobile-screenshots.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.clearAllMocks();
});

async function control() {
  const result = await startDeviceControlServer("emulator-5554");
  server = result.server;
  return result.url;
}

// No adb process or native app is started: only the loopback request handler runs.
describe("notification demo device control", () => {
  it("rejects physical or unscoped devices before binding", async () => {
    await expect(startDeviceControlServer("device-placeholder")).rejects.toThrow(
      "dedicated emulator",
    );
    await expect(startDeviceControlServer("")).rejects.toThrow("dedicated emulator");
    expect(execFile).not.toHaveBeenCalled();
  });
  it("binds an ephemeral loopback capability and rejects unrelated/browser requests", async () => {
    const url = await control();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/expand-notifications\/[\da-f-]{36}$/);
    for (const [target, init] of [
      [url.replace(/[^/]+$/, "wrong"), {}],
      [url, { method: "POST" }],
      [url, { headers: { origin: "https://example.test" } }],
    ] as const) {
      expect((await fetch(target, init)).status).toBe(404);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([false, true])("bounds the fixed adb command and reports failure=%s", async (fails) => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      callback(fails ? new Error("synthetic failure") : null);
      return {} as ReturnType<typeof execFile>;
    });
    const response = await fetch(await control());
    expect(response.status).toBe(fails ? 500 : 200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(execFile).toHaveBeenCalledWith(
      "adb",
      ["-s", "emulator-5554", "shell", "cmd", "statusbar", "expand-notifications"],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      expect.any(Function),
    );
  });

  it("kills an in-flight adb command when the controller closes", async () => {
    const kill = vi.fn();
    vi.mocked(execFile).mockReturnValue({ kill } as unknown as ReturnType<typeof execFile>);
    const url = await control();
    const request = fetch(url).catch(() => undefined);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce());
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await request;
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rejects concurrent expansion requests", async () => {
    let finish: ((error: Error | null) => void) | undefined;
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return {} as ReturnType<typeof execFile>;
    });
    const url = await control();
    const first = fetch(url);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await fetch(url)).status).toBe(429);
    finish!(null);
    expect((await first).status).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

const root = new URL("../../../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");
it("keeps synthetic recording optional, after sign-in, with bounded shade retries", () => {
  const cli = read("packages/testkit/src/cli/mobile-screenshots.ts");
  const flow = read("apps/mobile/.maestro/notification-demo.yaml");
  expect(cli).toContain('process.env.RAKAZO_NOTIFICATION_DEMO === "1"');
  expect(cli).toContain("!/^emulator-\\d+$/.test(serial)");
  expect(cli).toContain('AGENT_RUNTIME: "scripted"');
  expect(cli).toContain('SANDBOX_PROVIDER: "fake"');
  expect(cli).toContain('execFileSync("bun", ["run", "prisma", "migrate", "deploy"]');
  expect(flow.indexOf("- startRecording:")).toBeGreaterThan(
    flow.indexOf(`- inputText: \${RAKAZO_SCREENSHOT_PASSWORD}`),
  );
  expect(cli).toContain(
    '"--test-output-dir",\n          path.join(REPORT_DIR, "notification-demo")',
  );
  expect(flow).toContain("times: 8");
  expect(flow).toContain('- assertNotVisible: "Researcher is working"');
  expect(flow).toContain("- stopRecording");
});

it("publishes only the explicitly reviewed video, not debug or credential artifacts", () => {
  const script = read("scripts/publish-mobile-screenshot-gallery.sh");
  expect(script).toContain(`\${RAKAZO_PUBLISH_NOTIFICATION_DEMO:-}" == "1"`);
  expect(script).toContain('-s "$video_path" && ! -L "$video_path"');
  expect(script).toContain('--content-type "video/mp4"');
  expect(script).not.toContain("pnpm");
});
