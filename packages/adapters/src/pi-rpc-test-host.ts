import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProcessHost, PrivateDuplex } from "./pi-rpc-protocol.js";

/** TEST ONLY. This proves the real RPC/broker path, NOT OS filesystem isolation. Never exported by the package. */
export function createTestProcessHost(): AgentProcessHost & {
  starts: number;
  reaped: number;
  stderr: string[];
} {
  return {
    starts: 0,
    reaped: 0,
    stderr: [],
    async start(_scope, signal) {
      const root = await mkdtemp(join(tmpdir(), "rakazo-rpc-test-"));
      await mkdir(join(root, ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(root, ".pi", "extensions", "poison.ts"),
        'throw new Error("ambient extension loaded")',
      );
      const socketPath = join(root, "bridge.sock");
      const server = createServer();
      const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const child = spawn(
        process.execPath,
        [
          "--import",
          fileURLToPath(import.meta.resolve("tsx")),
          fileURLToPath(new URL("./pi-runner.ts", import.meta.url)),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            RAKAZO_AGENT_BRIDGE_SOCKET: socketPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.starts++;
      child.stderr.on("data", (data) => this.stderr.push(String(data)));
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => {
          this.reaped++;
          resolve();
        }),
      );
      let stopping: Promise<void> | undefined;
      let socket: Socket | undefined;
      const stop = () =>
        (stopping ??= (async () => {
          signal.removeEventListener("abort", abort);
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
          await exited;
          clearTimeout(timer);
          socket?.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        })());
      const abort = () => {
        void stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        socket = await Promise.race([
          connected,
          exited.then(() => {
            throw new Error(`Test worker exited: ${this.stderr.join("")}`);
          }),
        ]);
        const port = (
          incoming: AsyncIterable<Uint8Array>,
          writable: NodeJS.WritableStream,
        ): PrivateDuplex => ({
          incoming,
          write: (frame) =>
            new Promise<void>((resolve, reject) =>
              writable.write(frame, (error?: Error | null) => (error ? reject(error) : resolve())),
            ),
          close: stop,
        });
        return { rpc: port(child.stdout, child.stdin), bridge: port(socket, socket), stop };
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}
