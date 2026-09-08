import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerCredentials } from "./credentials.js";
import { runForwarder } from "./forwarder.js";
import { ForwardJournal } from "./journal.js";
import { MachineRevokedError, TunnelClient } from "./tunnel-client.js";

const TOKEN = "rk_m_abcdefghijklmnopqrstuvwxyz0123456789abcdef";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function listen(app: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => app(req, res));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let dir: string;
let tunnel: Server | undefined;
let supervisor: Server | undefined;

afterEach(async () => {
  tunnel?.close();
  supervisor?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-forwarder-"));
});

const credentials: RunnerCredentials = {
  serverUrl: "placeholder",
  machineId: "mach1",
  machineToken: TOKEN,
};

async function startFakeStack(options?: {
  supervisorRequests?: RecordedRequest[];
  supervisorStatus?: number;
  supervisorBody?: string;
  supervisorGate?: Promise<void>;
  deliveries?: Array<Record<string, unknown>>;
  pollStatus?: number;
  pollResponse?: Record<string, unknown>;
}) {
  const supervisorRequests = options?.supervisorRequests ?? [];
  supervisor = await listen((req, res) => {
    void readBody(req).then(async (body) => {
      supervisorRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers } as Record<string, string>,
        body,
      });
      await options?.supervisorGate;
      res.writeHead(options?.supervisorStatus ?? 200, { "content-type": "application/json" });
      res.end(options?.supervisorBody ?? '{"id":"container-1"}');
    });
  });
  const supervisorPort = (supervisor.address() as AddressInfo).port;

  const results: Array<Record<string, unknown>> = [];
  const pollCalls: Array<{ auth: string | undefined; body: string }> = [];
  let pairCount = 0;
  tunnel = await listen((req, res) => {
    void readBody(req).then(async (body) => {
      const auth = req.headers.authorization?.replace(/^Bearer /, "");
      if (req.url === "/api/machines/runner/pair") {
        pairCount += 1;
        if (pairCount > 1) {
          res.writeHead(410, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "already used" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ machineId: "mach1", token: TOKEN }));
        return;
      }
      if (req.url === "/api/machines/runner/poll") {
        pollCalls.push({ auth, body });
        if (options?.pollStatus) {
          res.writeHead(options.pollStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(options.pollResponse ?? {}));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ command: options?.deliveries?.shift() ?? null }));
        return;
      }
      if (req.url?.startsWith("/api/machines/runner/commands/") && req.url.endsWith("/result")) {
        results.push({ ...(JSON.parse(body) as object), auth });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/api/machines/runner/heartbeat") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const tunnelPort = (tunnel.address() as AddressInfo).port;
  return {
    results,
    pollCalls,
    tunnelUrl: `http://127.0.0.1:${tunnelPort}`,
    supervisorUrl: `http://127.0.0.1:${supervisorPort}`,
  };
}

async function stopSoon(signal: AbortController) {
  setTimeout(() => signal.abort(), 250);
}

describe("machine runner forwarder", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid concurrency %s before opening the journal",
    async (maxInFlight) => {
      await expect(
        runForwarder({
          credentials,
          home: dir,
          supervisor: {
            baseUrl: "http://supervisor.example",
            dataDir: path.join(dir, "data"),
            token: "local-secret",
          },
          maxInFlight,
        }),
      ).rejects.toThrow(RangeError);
      await expect(stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cancels a blocked poll when recovery discovers revocation", async () => {
    const journal = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    await journal.begin("recover", "POST", "/computers/box/stop");
    await journal.complete("recover", 200);
    const client = new TunnelClient({ serverUrl: "https://server.example" });
    let pollSignal: AbortSignal | undefined;
    vi.spyOn(client, "poll").mockImplementation((_token, _wait, signal) => {
      pollSignal = signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    vi.spyOn(client, "heartbeat").mockResolvedValue();
    vi.spyOn(client, "postResult").mockRejectedValue(new MachineRevokedError());
    const controller = new AbortController();
    try {
      await expect(
        runForwarder({
          credentials,
          client,
          home: dir,
          supervisor: {
            baseUrl: "http://supervisor.example",
            dataDir: path.join(dir, "data"),
            token: "local-secret",
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow(MachineRevokedError);
      expect(pollSignal?.aborted).toBe(true);
    } finally {
      controller.abort();
      vi.restoreAllMocks();
    }
  });

  it.each(["resume", "stop"])(
    "leaves commands unclaimed while saturated, then can %s",
    async (action) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requests: RecordedRequest[] = [];
      const stack = await startFakeStack({ supervisorRequests: requests, supervisorGate: gate });
      const client = new TunnelClient({ serverUrl: stack.tunnelUrl });
      const deliveries = [1, 2].map((id) => ({
        id: `limited-${id}`,
        method: "POST",
        path: "/computers/box/stop",
      }));
      // Immediate claim responses make over-claiming observable before supervisor I/O.
      const poll = vi
        .spyOn(client, "poll")
        .mockImplementation(async () => deliveries.shift() ?? null);
      const heartbeat = vi.spyOn(client, "heartbeat");
      const post = vi.spyOn(client, "postResult");
      const controller = new AbortController();
      const running = runForwarder({
        credentials,
        client,
        home: dir,
        supervisor: {
          baseUrl: stack.supervisorUrl,
          dataDir: path.join(dir, "data"),
          token: "local-secret",
        },
        signal: controller.signal,
        maxInFlight: 1,
        longPollWaitMs: 0,
      });
      try {
        await expect.poll(() => requests.length).toBe(1);
        expect(poll).toHaveBeenCalledTimes(1);
        expect(deliveries).toHaveLength(1);
        expect(poll.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
        expect(heartbeat.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
        if (action === "resume") {
          release();
          await expect.poll(() => stack.results.length).toBe(2);
          expect(requests).toHaveLength(2);
          expect(post.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
        } else {
          controller.abort();
          await running;
          expect(deliveries).toHaveLength(1);
          expect(requests).toHaveLength(1);
        }
      } finally {
        controller.abort();
        release();
        await running;
        vi.restoreAllMocks();
      }
    },
  );

  it("pairs once and refuses to reuse the single-use code", async () => {
    const stack = await startFakeStack();
    const first = await TunnelClient.pair(stack.tunnelUrl, { code: "rk_p_abc" });
    expect(first).toEqual({ machineId: "mach1", token: TOKEN });
    await expect(TunnelClient.pair(stack.tunnelUrl, { code: "rk_p_abc" })).rejects.toThrow(
      /already used/i,
    );
  });

  it("forwards a provision command with the local secret and a machine home path", async () => {
    const supervisorRequests: RecordedRequest[] = [];
    const stack = await startFakeStack({
      supervisorRequests,
      deliveries: [
        {
          id: "cmd-1",
          method: "POST",
          path: "/computers",
          headers: { "x-rakazo-bot-id": "home-key", "content-type": "application/json" },
          bodyBase64: Buffer.from(
            JSON.stringify({
              botId: "home-key",
              homePath: "/srv/backend-data/homes/home-key",
              spaceId: "sp1",
            }),
          ).toString("base64"),
        },
      ],
    });
    const controller = new AbortController();
    await stopSoon(controller);
    const dataDir = path.join(dir, "data");
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: { baseUrl: stack.supervisorUrl, dataDir, token: "local-secret" },
      client: new TunnelClient({ serverUrl: stack.tunnelUrl }),
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    const provision = supervisorRequests.find((req) => req.url === "/computers");
    expect(provision).toBeDefined();
    expect(provision?.headers.authorization).toBe("Bearer local-secret");
    const sent = JSON.parse(provision?.body ?? "{}") as {
      botId: string;
      homePath: string;
      spaceId: string;
    };
    expect(sent).toEqual({
      botId: "home-key",
      homePath: path.join(dataDir, "homes", "home-key"),
      spaceId: "sp1",
    });
    // The runner created the home itself (unprivileged) before forwarding.
    const homeStat = await stat(path.join(dataDir, "homes", "home-key"));
    expect(homeStat.isDirectory()).toBe(true);
  });

  it("posts the supervisor result back and journals it", async () => {
    const stack = await startFakeStack({
      supervisorBody: '{"id":"container-1","resumed":false}',
      deliveries: [{ id: "cmd-1", method: "GET", path: "/agents/a1/events", query: "cursor=-1" }],
    });
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: {
        baseUrl: stack.supervisorUrl,
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(stack.results[0]).toMatchObject({ status: 200 });
    const journal = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    expect(journal.lookup("cmd-1")).toMatchObject({ state: "delivered", status: 200 });
  });

  it("answers a redelivered command from the journal without re-executing", async () => {
    const journal = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    await journal.begin("cmd-1", "POST", "/computers/abc/stop");
    await journal.complete(
      "cmd-1",
      200,
      Buffer.from('{"ok":true}').toString("base64"),
      "application/json",
    );
    const supervisorRequests: RecordedRequest[] = [];
    const stack = await startFakeStack({
      supervisorRequests,
      deliveries: [{ id: "cmd-1", method: "POST", path: "/computers/abc/stop" }],
    });
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: {
        baseUrl: stack.supervisorUrl,
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(supervisorRequests).toHaveLength(0);
    expect(stack.results[0]).toMatchObject({ status: 200 });
  });

  it("fails closed on an uncertain mutation after a restart", async () => {
    const journal = await ForwardJournal.load(path.join(dir, "journal.jsonl"));
    await journal.begin("cmd-1", "POST", "/computers");
    const supervisorRequests: RecordedRequest[] = [];
    const stack = await startFakeStack({
      supervisorRequests,
      deliveries: [{ id: "cmd-1", method: "POST", path: "/computers" }],
    });
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: {
        baseUrl: stack.supervisorUrl,
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(supervisorRequests).toHaveLength(0);
    expect(stack.results[0]).toMatchObject({ status: 409 });
  });

  it("retries polling through server errors with backoff", async () => {
    let pollCount = 0;
    const stack = await startFakeStack();
    tunnel?.close();
    const pollFailures = { count: 0 };
    tunnel = await listen((req, res) => {
      void readBody(req).then((_body) => {
        if (req.url === "/api/machines/runner/poll") {
          pollCount += 1;
          if (pollCount <= 2) {
            pollFailures.count += 1;
            res.writeHead(500);
            res.end("{}");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ command: null }));
          return;
        }
        if (req.url === "/api/machines/runner/heartbeat") {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const port = (tunnel.address() as AddressInfo).port;
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: `http://127.0.0.1:${port}` },
      home: dir,
      supervisor: {
        baseUrl: stack.supervisorUrl,
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(pollFailures.count).toBe(2);
    expect(pollCount).toBeGreaterThan(2);
  });

  it("stops with a revocation failure when the server revokes the token", async () => {
    const stack = await startFakeStack({ pollStatus: 401, pollResponse: {} });
    const controller = new AbortController();
    await expect(
      runForwarder({
        credentials: { ...credentials, serverUrl: stack.tunnelUrl },
        home: dir,
        supervisor: {
          baseUrl: stack.supervisorUrl,
          dataDir: path.join(dir, "data"),
          token: "local-secret",
        },
        signal: controller.signal,
        pollIntervalMs: 10,
        longPollWaitMs: 0,
      }),
    ).rejects.toThrow(/revoked/i);
    controller.abort();
  });

  it("reports an unreachable local supervisor as a 502 result, never a hang", async () => {
    const stack = await startFakeStack({
      deliveries: [{ id: "cmd-1", method: "GET", path: "/agents/a1/events" }],
    });
    supervisor?.close();
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: {
        baseUrl: "http://127.0.0.1:1",
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(stack.results[0]).toMatchObject({ status: 502 });
  });

  it("rejects commands the local supervisor authority does not allow", async () => {
    const stack = await startFakeStack({
      deliveries: [{ id: "cmd-1", method: "GET", path: "/etc/passwd" }],
    });
    const controller = new AbortController();
    await stopSoon(controller);
    await runForwarder({
      credentials: { ...credentials, serverUrl: stack.tunnelUrl },
      home: dir,
      supervisor: {
        baseUrl: stack.supervisorUrl,
        dataDir: path.join(dir, "data"),
        token: "local-secret",
      },
      signal: controller.signal,
      pollIntervalMs: 10,
      longPollWaitMs: 0,
    });
    expect(stack.results[0]).toMatchObject({ status: 400 });
  });
});
