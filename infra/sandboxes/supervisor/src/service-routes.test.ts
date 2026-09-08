import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerServiceRoutes, serviceWorkingDirectory } from "./service-routes.js";

interface ExecCall {
  argv: string[];
  stdin: string;
  result: { stdout: string; stderr: string; code: number };
}

function harness(result: Partial<ExecCall["result"]> = {}) {
  const calls: ExecCall[] = [];
  const container = {
    exec: async (options: { Cmd: string[] }) => {
      const call: ExecCall = {
        argv: options.Cmd,
        stdin: "",
        result: { stdout: "{}", stderr: "", code: 0, ...result },
      };
      calls.push(call);
      return {
        start: async () => {
          // A half-duplex stub: writes carry the stdin payload, reads carry the
          // docker-multiplexed stdout/stderr frames (PassThrough would echo).
          const { Duplex } = await import("node:stream");
          const payload = Buffer.concat([
            encodeFrame(0, Buffer.from(call.result.stdout)),
            encodeFrame(2, Buffer.from(call.result.stderr)),
          ]);
          const stream = new Duplex({
            read() {},
            write: (chunk: Buffer, _enc: string, callback: (error?: Error) => void) => {
              call.stdin = String(chunk);
              setImmediate(() => {
                stream.push(payload);
                stream.push(null);
              });
              callback();
            },
          });
          return stream;
        },
        inspect: async () => ({ ExitCode: call.result.code }),
      };
    },
  };
  const app = new Hono();
  registerServiceRoutes(app, {
    managedContainer: async () => ({ container, info: {} as never }) as never,
  });
  return { app, calls };
}

function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const identityHeaders = {
  authorization: "Bearer test",
  "x-rakazo-bot-id": "bot-1",
  "x-rakazo-space-id": "space-1",
};

describe("service routes", () => {
  it("lists services through the in-image helper", async () => {
    const { app, calls } = harness({
      stdout: JSON.stringify({
        supported: true,
        services: [
          {
            name: "web",
            status: "running",
            pid: 5,
            ports: [3000],
            keepAlive: false,
            cwd: "/home/rakazo/app",
          },
        ],
      }),
    });
    const res = await app.request("/computers/comp-1/services", { headers: identityHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: { name: string }[] };
    expect(body.services[0]?.name).toBe("web");
    expect(calls[0]?.argv).toEqual(["python3", "/usr/local/bin/rakazo-service-ctl", "list"]);
  });

  it("translates virtual workspace cwd and passes argv untouched on declare", async () => {
    const { app, calls } = harness();
    const res = await app.request("/computers/comp-1/services", {
      method: "POST",
      headers: { ...identityHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        name: "web",
        argv: ["bash", "-c", "echo hi; rm -rf /"],
        cwd: "bots/b1/app",
        env: { PORT: "3000" },
        ports: [3000],
        keepAlive: true,
      }),
    });
    expect(res.status).toBe(200);
    const spec = JSON.parse(calls[0]?.stdin ?? "") as { argv: string[]; cwd: string; name: string };
    expect(spec.cwd).toBe("/home/rakazo/bots/b1/app");
    expect(spec.argv).toEqual(["bash", "-c", "echo hi; rm -rf /"]);
    expect(spec.name).toBe("web");
  });

  it("rejects declarations outside the computer home", async () => {
    const { app, calls } = harness();
    const res = await app.request("/computers/comp-1/services", {
      method: "POST",
      headers: { ...identityHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        name: "web",
        argv: ["x"],
        cwd: "/etc",
        env: {},
        ports: [],
        keepAlive: false,
      }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on invalid service names", async () => {
    const { app, calls } = harness();
    const res = await app.request("/computers/comp-1/services/..%2Fetc/stop", {
      method: "POST",
      headers: identityHeaders,
    });
    expect([400, 404]).toContain(res.status);
    expect(calls).toHaveLength(0);
  });

  it("maps helper failure codes to explicit statuses", async () => {
    const { app } = harness({ code: 2, stderr: "supervisord unreachable", stdout: "" });
    const res = await app.request("/computers/comp-1/services", { headers: identityHeaders });
    expect(res.status).toBe(501);
  });

  it("refuses websocket previews explicitly", async () => {
    const { app, calls } = harness();
    const res = await app.request("/computers/comp-1/services/web/preview/3000/", {
      headers: { ...identityHeaders, upgrade: "websocket" },
    });
    expect(res.status).toBe(501);
    expect(calls).toHaveLength(0);
  });

  it("previews through the container loopback with isolation headers", async () => {
    const { app, calls } = harness({
      stdout: JSON.stringify({
        status: 200,
        contentType: "text/html",
        bodyBase64: Buffer.from("<html>ok</html>").toString("base64"),
      }),
    });
    const res = await app.request("/computers/comp-1/services/web/preview/3000/assets/app.js?a=1", {
      headers: identityHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("<html>ok</html>");
    const request = JSON.parse(calls[0]?.stdin ?? "") as {
      path: string;
      port: number;
      name: string;
      query: string;
    };
    expect(request.path).toBe("/assets/app.js");
    expect(request.port).toBe(3000);
    expect(request.name).toBe("web");
    expect(request.query).toBe("a=1");
  });

  it("rejects preview ports outside the loopback range", async () => {
    const { app, calls } = harness();
    const res = await app.request("/computers/comp-1/services/web/preview/80/", {
      headers: identityHeaders,
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("serviceWorkingDirectory", () => {
  it("translates virtual workspace paths and pins absolute ones to the home", () => {
    expect(serviceWorkingDirectory("bots/b1/app")).toBe("/home/rakazo/bots/b1/app");
    expect(serviceWorkingDirectory("/home/rakazo/app")).toBe("/home/rakazo/app");
    expect(() => serviceWorkingDirectory("/etc")).toThrow();
    expect(() => serviceWorkingDirectory("/home/rakazo/../etc")).toThrow();
  });
});
