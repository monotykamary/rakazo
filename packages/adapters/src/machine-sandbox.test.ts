import type { AdapterContext, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MachineSandboxProvider,
  machineBoundComputerId,
  parseMachineBoundComputerId,
} from "./machine-sandbox.js";

const context: AdapterContext = {
  operationId: "machine-test",
  traceId: "machine-test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function fetchStub(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    ),
  );
  return mock;
}

const provisionResponse = () => Response.json({ id: "container-1", resumed: false });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("machine sandbox", () => {
  it("binds computer refs to their machine so they can never retarget", () => {
    const bound = machineBoundComputerId("mach1", "container-1");
    expect(bound).toBe("machine:mach1:container-1");
    expect(parseMachineBoundComputerId(bound)).toEqual({
      machineId: "mach1",
      computerId: "container-1",
    });
    expect(parseMachineBoundComputerId("container-1")).toBeUndefined();
    expect(parseMachineBoundComputerId("machine:mach1:")).toBeUndefined();
    expect(parseMachineBoundComputerId("machine:bad id!:container-1")).toBeUndefined();
    expect(() => machineBoundComputerId("bad id", "container-1")).toThrow(/machine/i);
  });

  it("provisions through the tunnel and returns a machine-bound ref", async () => {
    const http = fetchStub(() => provisionResponse());
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const created = await provider.provision({ botId: "home-key", homePath: "/ignored" }, context);
    expect(created).toMatchObject({
      id: "machine:mach1:container-1",
      providerRef: "machine:mach1:container-1",
      botId: "home-key",
      kind: "machine",
      fresh: true,
    });
    const [url, init] = http.mock.calls[0] ?? [];
    expect(String(url)).toContain("/computers");
    // The machine runner substitutes the local supervisor secret; no bearer leaves the backend.
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toMatchObject({ botId: "home-key" });
  });

  it("routes operations by unwrapping the machine-bound id", async () => {
    const http = fetchStub((url) => {
      if (url.endsWith("/exec")) return Response.json({ stdout: "out", stderr: "", code: 0 });
      return provisionResponse();
    });
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const created = await provider.provision({ botId: "home-key", homePath: "/ignored" }, context);
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(created, { argv: ["echo", "hi"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "exit", code: 0 },
    ]);
    expect(String(http.mock.calls[1]?.[0])).toContain("/computers/container-1/exec");
  });

  it("degrades graphical capabilities explicitly instead of promising remote screens", async () => {
    const http = fetchStub(() => provisionResponse());
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const described = provider.describe();
    expect(described.capabilities).toMatchObject({
      graphical: false,
      takeover: false,
      multiScreen: false,
    });
    const created = await provider.provision({ botId: "home-key", homePath: "/ignored" }, context);
    await expect(
      provider.connectScreen(created, { view: "stream" }, context),
    ).resolves.toMatchObject({
      url: null,
    });
  });

  it("transfers workspace files portably over the tunnel", async () => {
    const http = fetchStub((url) => {
      if (url.includes("/files?") && url.includes("mode=list")) {
        return Response.json([{ path: "notes.txt", kind: "file", size: 5, executable: false }]);
      }
      if (url.includes("/files?") && url.includes("mode=read")) {
        return Response.json({ content: Buffer.from("hello").toString("base64") });
      }
      return Response.json({ ok: true });
    });
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const created = await provider.provision({ botId: "home-key", homePath: "/ignored" }, context);
    const exported = [];
    for await (const file of provider.exportWorkspace(created, context)) exported.push(file);
    expect(exported).toEqual([
      { path: "notes.txt", content: new TextEncoder().encode("hello"), executable: false },
    ]);
  });

  it("fails closed for a foreign machine-bound ref instead of retargeting", async () => {
    const http = fetchStub(() => Response.json({ stdout: "", stderr: "", code: 0 }));
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const foreign = {
      id: "machine:mach2:container-9",
      botId: "bot-1",
      kind: "machine" as const,
      providerRef: "machine:mach2:container-9",
    };
    await expect(provider.stop(foreign, context)).rejects.toThrow(/another machine/);
    const delegated = fetchStub(() => Response.json({ ok: true }));
    const mach2 = new MachineSandboxProvider({
      machineId: "mach2",
      fetch: delegated as unknown as typeof fetch,
    });
    const withResolver = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
      resolveMachine: (machineId) => (machineId === "mach2" ? mach2 : undefined),
    });
    // Cleanup after reassignment runs on the owning machine, never by retargeting the ref.
    await expect(withResolver.stop(foreign, context)).resolves.toBeUndefined();
    expect(String(delegated.mock.calls[0]?.[0])).toContain("/computers/container-9/stop");
  });
});

describe("machine routing sandbox", () => {
  it("forwards the full sandbox surface by ref kind", async () => {
    const http = fetchStub((url) => {
      if (url.includes("/observe")) {
        return Response.json({
          image: Buffer.from("png").toString("base64"),
          mimeType: "image/png",
          width: 1,
          height: 1,
        });
      }
      return Response.json({ id: "container-1", resumed: false });
    });
    const provider = new MachineSandboxProvider({
      machineId: "mach1",
      fetch: http as unknown as typeof fetch,
    });
    const created = await provider.provision({ botId: "home-key", homePath: "/ignored" }, context);
    const observation = await provider.observe(created, context);
    expect(observation.width).toBe(1);
    expect(String(http.mock.calls.at(-1)?.[0])).toContain("/computers/container-1/observe");
  });
});
