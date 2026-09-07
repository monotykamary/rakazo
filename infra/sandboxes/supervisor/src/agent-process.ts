import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { type Duplex, PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type Docker from "dockerode";

const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROCESSES = 32;
const IDLE_TIMEOUT_MS = 5 * 60_000;
export const AGENT_IMAGE = process.env.RAKAZO_AGENT_IMAGE ?? "rakazo/agent:local";

export interface AgentProcessIdentity {
  runId: string;
  botId: string;
  spaceId: string;
}
export interface AgentProcessFrame {
  seq: number;
  channel: "rpc" | "bridge" | "stderr" | "exit";
  data: string;
}
interface ManagedProcess {
  identity: AgentProcessIdentity;
  container: Docker.Container;
  directory: string;
  server: Server;
  input: Duplex;
  bridge?: Socket;
  frames: AgentProcessFrame[];
  nextSeq: number;
  bytes: number;
  closed: boolean;
  lastAccess: number;
  waiters: Set<() => void>;
  cleanup?: Promise<void>;
}

/** All mounts and command arguments are supervisor-owned, never supplied by a caller. */
export function agentContainerOptions(
  bridgeDirectory: string,
  identity: AgentProcessIdentity,
  image = AGENT_IMAGE,
): Docker.ContainerCreateOptions {
  return {
    Image: image,
    Cmd: ["node", "--import", "tsx", "/app/packages/adapters/src/pi-runner.ts"],
    User: "1000:1000",
    WorkingDir: "/work",
    Env: [
      "HOME=/work",
      "PI_CODING_AGENT_DIR=/work/.pi",
      "PI_OFFLINE=1",
      "RAKAZO_AGENT_BRIDGE_SOCKET=/run/rakazo/bridge.sock",
    ],
    Labels: {
      "rakazo.kind": "agent",
      "rakazo.runId": identity.runId,
      "rakazo.botId": identity.botId,
      "rakazo.spaceId": identity.spaceId,
    },
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 2 * 1024 ** 3,
      NanoCpus: 2_000_000_000,
      PidsLimit: 128,
      Binds: [`${bridgeDirectory}:/run/rakazo:ro`],
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=256m,mode=1777",
        "/work": "rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=700",
      },
      AutoRemove: false,
    },
  };
}

export class AgentProcessHost {
  private readonly processes = new Map<string, ManagedProcess>();
  private creating = 0;
  private bufferBytes = 0;
  private closing = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      docker: Docker;
      bridgeRoot: string;
      hostPath: (servicePath: string) => Promise<string>;
      image?: string;
    },
  ) {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [id, process] of this.processes) {
        if (now - process.lastAccess > IDLE_TIMEOUT_MS)
          void this.remove(id, process.identity).catch(() => undefined);
      }
    }, 30_000);
    this.timer.unref();
  }

  async start(identity: AgentProcessIdentity): Promise<{ id: string }> {
    if (this.closing) throw new Error("Agent host is stopping");
    if (this.processes.size + this.creating >= MAX_PROCESSES)
      throw new Error("Agent process capacity reached");
    this.creating++;
    let directory: string | undefined;
    let server: Server | undefined;
    let container: Docker.Container | undefined;
    try {
      await this.options.docker.getImage(this.options.image ?? AGENT_IMAGE).inspect();
      await mkdir(this.options.bridgeRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(this.options.bridgeRoot, "run-"));
      // The directory contains only this run's socket. Traversal is required by the unprivileged worker.
      await chmod(directory, 0o711);
      const socketPath = path.join(directory, "bridge.sock");
      let managed: ManagedProcess | undefined;
      server = createServer((socket) => {
        if (!managed || managed.closed || managed.bridge) {
          socket.destroy();
          return;
        }
        managed.bridge = socket;
        const decoder = new StringDecoder("utf8");
        socket.on("data", (data: Buffer) => this.append(managed!, "bridge", decoder.write(data)));
        socket.on("end", () => {
          const tail = decoder.end();
          if (tail) this.append(managed!, "bridge", tail);
          if (!managed!.closed) void this.terminate(managed!, "bridge disconnected");
        });
        socket.on("error", () => {
          if (!managed!.closed) void this.terminate(managed!, "bridge failed");
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o666);
      const hostDirectory = await this.options.hostPath(directory);
      container = await this.options.docker.createContainer(
        agentContainerOptions(hostDirectory, identity, this.options.image),
      );
      const input = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as Duplex;
      if (this.closing) {
        input.destroy();
        throw new Error("Agent host is stopping");
      }
      managed = {
        identity: { ...identity },
        container,
        directory,
        server,
        input,
        frames: [],
        nextSeq: 0,
        bytes: 0,
        closed: false,
        lastAccess: Date.now(),
        waiters: new Set(),
      };
      const id = randomUUID();
      this.processes.set(id, managed);
      const outputs = ["rpc", "stderr"].map((channel) => {
        const output = new PassThrough();
        const decoder = new StringDecoder("utf8");
        output.on("data", (data: Buffer) =>
          this.append(managed!, channel as "rpc" | "stderr", decoder.write(data)),
        );
        output.on("end", () => {
          const tail = decoder.end();
          if (tail) this.append(managed!, channel as "rpc" | "stderr", tail);
        });
        return output;
      });
      this.options.docker.modem.demuxStream(input, outputs[0]!, outputs[1]!);
      input.on("error", () => {
        if (!managed!.closed) void this.terminate(managed!, "RPC transport failed");
      });
      try {
        await container.start();
      } catch (error) {
        managed.closed = true;
        input.destroy();
        managed.bridge?.destroy();
        if (this.processes.delete(id)) this.bufferBytes -= managed.bytes;
        throw error;
      }
      if (this.closing) {
        await this.remove(id, identity);
        throw new Error("Agent host is stopping");
      }
      void container.wait().then(
        (result) => this.terminate(managed!, `exit:${result.StatusCode}`),
        () => this.terminate(managed!, "agent process unavailable"),
      );
      return { id };
    } catch (error) {
      await container?.remove({ force: true }).catch(() => undefined);
      server?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.creating--;
    }
  }

  private get(id: string, identity: AgentProcessIdentity): ManagedProcess {
    const process = this.processes.get(id);
    if (
      !process ||
      process.identity.runId !== identity.runId ||
      process.identity.botId !== identity.botId ||
      process.identity.spaceId !== identity.spaceId
    ) {
      throw new Error("Agent process unavailable");
    }
    process.lastAccess = Date.now();
    return process;
  }

  async send(
    id: string,
    identity: AgentProcessIdentity,
    channel: "rpc" | "bridge",
    data: string,
  ): Promise<void> {
    const process = this.get(id, identity);
    if (process.closed) throw new Error("Agent process closed");
    if (!data.endsWith("\n") || Buffer.byteLength(data) > MAX_INPUT_BYTES)
      throw new Error("Invalid agent input frame");
    const target = channel === "rpc" ? process.input : process.bridge;
    if (!target) throw new Error("Agent bridge is not ready");
    await new Promise<void>((resolve, reject) => {
      target.write(data, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  async events(
    id: string,
    identity: AgentProcessIdentity,
    cursor: number,
    signal?: AbortSignal,
  ): Promise<{ frames: AgentProcessFrame[]; cursor: number; closed: boolean }> {
    const process = this.get(id, identity);
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor >= process.nextSeq)
      throw new Error("Invalid agent cursor");
    while (process.frames[0] && process.frames[0].seq <= cursor) {
      const bytes = Buffer.byteLength(process.frames.shift()!.data);
      process.bytes -= bytes;
      this.bufferBytes -= bytes;
    }
    if (!process.frames.length && !process.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", done);
          process.waiters.delete(done);
          resolve();
        };
        const timeout = setTimeout(done, 15_000);
        process.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    }
    const frames = process.frames.slice(0, 256);
    return {
      frames,
      cursor: frames.at(-1)?.seq ?? cursor,
      closed: process.closed && frames.length === process.frames.length,
    };
  }

  private append(
    process: ManagedProcess,
    channel: AgentProcessFrame["channel"],
    data: string,
  ): void {
    if (!data || process.closed) return;
    const bytes = Buffer.byteLength(data);
    if (
      process.bytes + bytes > MAX_BUFFER_BYTES ||
      this.bufferBytes + bytes > MAX_TOTAL_BUFFER_BYTES
    ) {
      void this.terminate(process, "Agent output limit exceeded");
      return;
    }
    process.frames.push({ seq: process.nextSeq++, channel, data });
    process.bytes += bytes;
    this.bufferBytes += bytes;
    for (const done of [...process.waiters]) done();
  }

  private terminate(process: ManagedProcess, reason: string): Promise<void> {
    if (process.cleanup) return process.cleanup;
    process.frames.push({ seq: process.nextSeq++, channel: "exit", data: reason });
    process.bytes += Buffer.byteLength(reason);
    this.bufferBytes += Buffer.byteLength(reason);
    process.closed = true;
    for (const done of [...process.waiters]) done();
    process.cleanup = (async () => {
      process.bridge?.destroy();
      process.input.destroy();
      process.server.close();
      await process.container.remove({ force: true }).catch(() => undefined);
      await rm(process.directory, { recursive: true, force: true });
    })();
    return process.cleanup;
  }

  async remove(id: string, identity: AgentProcessIdentity): Promise<void> {
    const process = this.get(id, identity);
    await this.terminate(process, "stopped");
    if (this.processes.delete(id)) this.bufferBytes -= process.bytes;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.processes].map(([id, process]) => this.remove(id, process.identity)),
    );
  }
}
