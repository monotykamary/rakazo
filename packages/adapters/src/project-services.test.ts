import { describe, expect, it } from "vitest";
import {
  createSupervisorServiceCapability,
  previewRequestBodyBase64,
  readComputerChanges,
  type SupervisorServiceTransport,
} from "./project-services.js";

function transport(
  responder: (path: string, init: RequestInit) => Response,
): SupervisorServiceTransport {
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(responder(String(input), init ?? {}))) as typeof fetch,
    url: (path: string) => `http://supervisor.test${path}`,
    headers: (context) => ({ "x-rakazo-space-id": context.spaceId }),
  };
}

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const computer = { id: "comp-1", botId: "bot-1", kind: "docker" as const, providerRef: "comp-1" };

describe("supervisor service capability", () => {
  it("lists services and reports unsupported", async () => {
    const calls: string[] = [];
    const services = createSupervisorServiceCapability(
      transport((path) => {
        calls.push(path);
        return Response.json({
          supported: true,
          services: [
            {
              name: "web",
              status: "running",
              pid: 5,
              ports: [3000],
              keepAlive: true,
              cwd: "/home/rakazo/app",
            },
          ],
        });
      }),
    );
    const result = await services.list(computer, context);
    expect(result.supported).toBe(true);
    expect(result.services[0]?.name).toBe("web");
    expect(calls[0]?.endsWith("/computers/comp-1/services")).toBe(true);

    const unsupported = createSupervisorServiceCapability(
      transport(() => Response.json({ supported: false, services: [] })),
    );
    expect((await unsupported.list(computer, context)).supported).toBe(false);
  });

  it("declares with argv intact and rejects invalid names and ports", async () => {
    const bodies: unknown[] = [];
    const services = createSupervisorServiceCapability(
      transport((path, init) => {
        bodies.push(init.body);
        return Response.json({ ok: true });
      }),
    );
    await services.declare(
      computer,
      {
        name: "web",
        argv: ["bash", "-c", "echo hi; rm -rf /"],
        cwd: "bots/b1/app",
        env: { PORT: "3000" },
        ports: [3000],
        keepAlive: false,
      },
      context,
    );
    expect(bodies[0]).toContain("echo hi; rm -rf /");
    await expect(
      services.declare(
        computer,
        { name: "BAD NAME", argv: ["x"], cwd: ".", env: {}, ports: [], keepAlive: false },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      services.declare(
        computer,
        { name: "web", argv: ["x"], cwd: ".", env: {}, ports: [80], keepAlive: false },
        context,
      ),
    ).rejects.toThrow();
  });

  it("composes stop/restart/remove urls with the fixed service tree", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const services = createSupervisorServiceCapability(
      transport((path, init) => {
        calls.push({ path, method: init.method ?? "GET" });
        return Response.json({ ok: true });
      }),
    );
    await services.stop(computer, "web", context);
    await services.restart(computer, "web", context);
    await services.remove(computer, "web", context);
    expect(
      calls.map((call) => `${call.method} ${call.path.replace("http://supervisor.test", "")}`),
    ).toEqual([
      "POST /computers/comp-1/services/web/stop",
      "POST /computers/comp-1/services/web/restart",
      "DELETE /computers/comp-1/services/web",
    ]);
  });

  it("preview refuses paths the tunnel cannot carry", async () => {
    const services = createSupervisorServiceCapability(
      transport(() =>
        Response.json({ status: 200, contentType: "text/html", bodyBase64: undefined }),
      ),
    );
    await expect(
      services.preview(
        computer,
        { name: "web", port: 3000, method: "GET", path: "assets/app.js", query: "" },
        context,
      ),
    ).resolves.toBeTruthy();
    await expect(
      services.preview(
        computer,
        { name: "web", port: 3000, method: "GET", path: "file name with spaces", query: "" },
        context,
      ),
    ).rejects.toThrow("unsupported characters");
  });

  it("preview request bodies are base64 encoded once", () => {
    expect(previewRequestBodyBase64("hello")).toBe(Buffer.from("hello").toString("base64"));
    expect(previewRequestBodyBase64("")).toBeUndefined();
    expect(() => previewRequestBodyBase64(new Uint8Array(9 * 1024 * 1024))).toThrow("too large");
  });
});

describe("readComputerChanges", () => {
  function sandboxFrom(
    argvLog: string[][],
    script: (argv: string[]) => { out: string; code: number },
  ) {
    return {
      execute: (computerArg: unknown, request: { argv: string[] }) =>
        (async function* () {
          argvLog.push(request.argv);
          const result = script(request.argv);
          if (result.out) yield { type: "stdout" as const, data: result.out };
          yield { type: "exit" as const, code: result.code };
        })(),
    } as unknown as Parameters<typeof readComputerChanges>[0];
  }

  it("runs read-only git with fixed argv and bounded output", async () => {
    const argvLog: string[][] = [];
    const sandbox = sandboxFrom(argvLog, (argv) =>
      argv.includes("diff")
        ? { out: "diff --git a/x b/x\n".repeat(40 * 1024), code: 0 }
        : argv.includes("status")
          ? { out: " M x\n", code: 0 }
          : { out: "main\n", code: 0 },
    );
    const changes = await readComputerChanges(
      sandbox,
      computer,
      { cwd: "bots/b1/app", paths: ["src/app.ts"] },
      context,
    );
    expect(changes.branch).toBe("main");
    expect(changes.status).toContain(" M x");
    expect(changes.truncated).toBe(true);
    expect(changes.diff.length).toBeLessThanOrEqual(128 * 1024);
    for (const argv of argvLog) {
      expect(argv[0]).toBe("git");
      expect(argv).not.toContain("push");
      expect(argv).not.toContain("fetch");
    }
    const diffArgv = argvLog.find((argv) => argv.includes("diff"));
    expect(diffArgv?.includes("--")).toBe(true);
    expect(diffArgv?.slice(-1)).toEqual(["src/app.ts"]);
  });

  it("refuses unsafe paths instead of silently broadening the review", async () => {
    const argvLog: string[][] = [];
    const sandbox = sandboxFrom(argvLog, () => ({ out: "", code: 0 }));
    await expect(
      readComputerChanges(
        sandbox,
        computer,
        { cwd: "bots/b1/app", paths: ["src", "../../etc", "/absolute"] },
        context,
      ),
    ).rejects.toThrow("relative workspace files");
    expect(argvLog).toEqual([]);
  });

  it("treats option-shaped filenames and pathspec magic as literal files", async () => {
    const argvLog: string[][] = [];
    const sandbox = sandboxFrom(argvLog, () => ({ out: "", code: 0 }));
    const paths = ["--help", ":(top,glob)**", "file..txt"];
    await readComputerChanges(sandbox, computer, { cwd: "bots/b1/app", paths }, context);
    for (const argv of argvLog.filter((args) => args.includes("status") || args.includes("diff"))) {
      expect(argv).toContain("--no-pager");
      expect(argv).toContain("--literal-pathspecs");
      expect(argv.slice(argv.indexOf("--") + 1)).toEqual(paths);
    }
  });
});
