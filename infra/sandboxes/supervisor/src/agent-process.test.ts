import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, type Writable } from "node:stream";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProcessHost, agentContainerOptions } from "./agent-process.js";
import { agentProcessRoutes } from "./agent-routes.js";

const identity = { runId: "run-1", botId: "bot-1", spaceId: "space-1" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-agent-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callback();
    },
  });
  let stdout!: Writable;
  const remove = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const container = {
    attach: vi.fn(async () => stream),
    start,
    remove,
    wait: () => new Promise(() => {}),
  };
  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: "image" }) }),
    createContainer: vi.fn(async () => container),
    modem: {
      demuxStream: (_input: unknown, output: Writable) => {
        stdout = output;
      },
    },
  };
  const host = new AgentProcessHost({
    docker: docker as unknown as Docker,
    bridgeRoot: root,
    hostPath: async (p) => p,
  });
  cleanups.push(() => host.close());
  const { id } = await host.start(identity);
  const [directory] = await readdir(root);
  return {
    root,
    host,
    id,
    writes,
    docker,
    remove,
    start,
    stdout: () => stdout,
    socketPath: path.join(root, directory!, "bridge.sock"),
  };
}
function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("isolated agent process", () => {
  it("uses a fixed command and isolated mount/resource policy", () => {
    const options = agentContainerOptions("/run/owned-bridge", identity);
    expect(options.User).toBe("1000:1000");
    expect(options.Cmd).toEqual([
      "node",
      "--import",
      "tsx",
      "/app/packages/adapters/src/pi-runner.ts",
    ]);
    expect(options.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
    });
    expect(options.HostConfig?.Binds).toEqual(["/run/owned-bridge:/run/rakazo:ro"]);
    expect(options.Env?.some((value) => /API_KEY|SECRET|TOKEN/.test(value))).toBe(false);
  });
  it("isolates identities and transports stock RPC input", async () => {
    const { host, id, writes } = await fixture();
    await expect(host.send(id, { ...identity, spaceId: "other" }, "rpc", "{}\n")).rejects.toThrow(
      "unavailable",
    );
    await host.send(id, identity, "rpc", '{"type":"get_state"}\n');
    expect(writes).toEqual(['{"type":"get_state"}\n']);
    await expect(host.send(id, identity, "rpc", "{}")).rejects.toThrow("Invalid");
  });
  it("retains UTF8 across transport chunks and acknowledges cursor delivery", async () => {
    const { host, id, stdout } = await fixture();
    const bytes = Buffer.from('{"text":"hello 🧵"}\n');
    const split = bytes.indexOf(Buffer.from("🧵")) + 1;
    stdout().write(bytes.subarray(0, split));
    stdout().write(bytes.subarray(split));
    const page = await host.events(id, identity, -1);
    expect(page.frames.map((frame) => frame.data).join("")).toBe(bytes.toString());
    expect(page.frames.every((frame) => frame.channel === "rpc")).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect((await host.events(id, identity, page.cursor, controller.signal)).frames).toEqual([]);
  });
  it("keeps the reverse bridge separate and reaps it on stop", async () => {
    const { host, id, socketPath, remove, root } = await fixture();
    const socket = await connect(socketPath);
    socket.write('{"type":"hello"}\n');
    const page = await host.events(id, identity, -1);
    expect(page.frames[0]).toMatchObject({ channel: "bridge", data: '{"type":"hello"}\n' });
    const reply = new Promise<string>((resolve) =>
      socket.once("data", (data) => resolve(String(data))),
    );
    await host.send(id, identity, "bridge", '{"type":"init"}\n');
    expect(await reply).toBe('{"type":"init"}\n');
    await host.remove(id, identity);
    expect(remove).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
    await expect(host.events(id, identity, page.cursor)).rejects.toThrow("unavailable");
    socket.destroy();
  });
  it("rejects launches once the host is stopped", async () => {
    const { host } = await fixture();
    await host.close();
    await expect(host.start(identity)).rejects.toThrow("stopping");
  });
  it("reaps a launch that races host shutdown", async () => {
    const { host, docker, root } = await fixture();
    let release!: (value: Awaited<ReturnType<typeof docker.createContainer>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof docker.createContainer>>>((resolve) => {
      release = resolve;
    });
    const container = await docker.createContainer.mock.results[0]!.value;
    docker.createContainer.mockImplementationOnce(() => pending);
    const launching = host.start(identity);
    const rejected = expect(launching).rejects.toThrow("stopping");
    await vi.waitFor(() => expect(docker.createContainer).toHaveBeenCalledTimes(2));
    await host.close();
    release(container);
    await rejected;
    expect(await readdir(root)).toEqual([]);
  });
  it("terminates a slow consumer instead of retaining unlimited output", async () => {
    const { host, id, stdout, remove } = await fixture();
    stdout().write("x".repeat(33 * 1024 * 1024));
    const page = await host.events(id, identity, -1);
    expect(page.closed).toBe(true);
    expect(page.frames).toEqual([{ seq: 0, channel: "exit", data: "Agent output limit exceeded" }]);
    await host.remove(id, identity);
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("agent transport authorization", () => {
  const token = "test-supervisor-token";
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-rakazo-run-id": identity.runId,
    "x-rakazo-bot-id": identity.botId,
    "x-rakazo-space-id": identity.spaceId,
  };
  it("requires bearer auth and matching frozen scope before launch", async () => {
    const start = vi.fn(async () => ({ id: "opaque" }));
    const host = { start, send: vi.fn(), events: vi.fn(), remove: vi.fn() };
    const app = agentProcessRoutes(host, token);
    expect(
      (await app.request("/", { method: "POST", body: JSON.stringify(identity) })).status,
    ).toBe(401);
    expect(
      (
        await app.request("/", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...identity, spaceId: "other" }),
        })
      ).status,
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect(
      (await app.request("/", { method: "POST", headers, body: JSON.stringify(identity) })).status,
    ).toBe(201);
    expect(start).toHaveBeenCalledWith(identity);
  });
  it("never accepts caller-selected image, mount or command", async () => {
    const start = vi.fn();
    const app = agentProcessRoutes(
      { start, send: vi.fn(), events: vi.fn(), remove: vi.fn() },
      token,
    );
    const response = await app.request("/", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...identity, image: "unsafe", mounts: ["/:/host"] }),
    });
    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not expose infrastructure errors to the caller", async () => {
    const start = vi.fn(async () => {
      throw new Error("private runtime diagnostic");
    });
    const app = agentProcessRoutes(
      { start, send: vi.fn(), events: vi.fn(), remove: vi.fn() },
      token,
    );
    const response = await app.request("/", {
      method: "POST",
      headers,
      body: JSON.stringify(identity),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});
