import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ComputerServicePreviewRequest,
  ComputerServiceSpec,
  ComputerServicesCapability,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { MachineAgentProcessHost } from "./machine-agent-host.js";
import { MachineSandboxProvider, parseMachineBoundComputerId } from "./machine-sandbox.js";
import type { AgentProcessHost, AgentProcessScope } from "./pi-rpc-protocol.js";

export interface MachineRoutingOptions {
  prisma: PrismaClient;
  /**
   * Machine-bound fetch factory (A's tunnel): createMachineFetch(machinesService, machineId)
   * curried by composition so this module stays independent of the service type.
   */
  machineFetch: (machineId: string) => typeof fetch;
  /**
   * Backend-local sandbox and host for bots without a machine assignment. Both are
   * optional: a machine-only deployment omits them, and an unassigned bot then fails
   * closed with an isolation error instead of landing on an unintended local sandbox.
   */
  fallbackSandbox?: SandboxProvider;
  fallbackHost?: AgentProcessHost;
}

export interface MachineRouting {
  sandbox: SandboxProvider;
  host: AgentProcessHost;
}

async function machineForProvision(
  prisma: PrismaClient,
  homeKey: string,
  spaceId: string,
): Promise<string | null> {
  const computer = await prisma.computer.findFirst({
    where: { homeKey, spaceId },
    select: { machineId: true },
  });
  return computer?.machineId ?? null;
}

/** A missing bot is an isolation failure, never a reason to fall back locally. */
async function machineForRun(
  prisma: PrismaClient,
  botId: string,
  spaceId: string,
): Promise<string | null> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId, archivedAt: null },
    select: { computer: { select: { machineId: true } } },
  });
  if (!bot) throw new Error(`Bot ${botId} does not exist in this space; refusing to start a run`);
  return bot.computer?.machineId ?? null;
}

/**
 * Outer per-operation routing between the backend-local sandbox/host and machine providers.
 * Machine-bound refs (kind "machine") always route to the machine embedded in the ref, even
 * after the bot was reassigned: cleanup and workspace transfer go to the owning machine and
 * never retarget. Assignment is resolved dynamically per operation, so placement changes take
 * effect on the next provision or run start without recreating the composition.
 */
export function createMachineRouting(options: MachineRoutingOptions): MachineRouting {
  const { prisma } = options;

  const sandboxByMachine = new Map<string, MachineSandboxProvider>();
  const hostByMachine = new Map<string, MachineAgentProcessHost>();

  const machineSandbox = (machineId: string) => {
    let provider = sandboxByMachine.get(machineId);
    if (!provider) {
      provider = new MachineSandboxProvider({ machineId, fetch: options.machineFetch(machineId) });
      sandboxByMachine.set(machineId, provider);
    }
    return provider;
  };

  const machineHost = (machineId: string) => {
    let host = hostByMachine.get(machineId);
    if (!host) {
      host = new MachineAgentProcessHost({ machineId, fetch: options.machineFetch(machineId) });
      hostByMachine.set(machineId, host);
    }
    return host;
  };

  class MachineRoutingSandbox implements SandboxProvider {
    readonly pageBrowser?: SandboxProvider["pageBrowser"];
    readonly services: ComputerServicesCapability;

    constructor() {
      this.pageBrowser = (computer, request, context) => {
        const { provider, ref } = this.route(computer);
        if (!provider.pageBrowser) {
          return Promise.resolve({
            ok: false,
            uncertain: false,
            fallback: "computer_act",
            error: "Page browser is unavailable on this computer.",
          });
        }
        return provider.pageBrowser(ref, request, context);
      };
      this.services = {
        list: (computer, context) =>
          this.withServices(computer, (services, ref) => services.list(ref, context)),
        declare: (computer, spec, context) =>
          this.withServices(computer, (services, ref) => services.declare(ref, spec, context)),
        stop: (computer, name, context) =>
          this.withServices(computer, (services, ref) => services.stop(ref, name, context)),
        restart: (computer, name, context) =>
          this.withServices(computer, (services, ref) => services.restart(ref, name, context)),
        remove: (computer, name, context) =>
          this.withServices(computer, (services, ref) => services.remove(ref, name, context)),
        preview: (computer, request, context) =>
          this.withServices(computer, (services, ref) => services.preview(ref, request, context)),
      };
    }

    private async withServices<R>(
      computer: ComputerRef,
      run: (services: ComputerServicesCapability, ref: ComputerRef) => Promise<R>,
    ): Promise<R> {
      const { provider, ref } = this.route(computer);
      const services = provider.services;
      if (!services) throw new Error("This computer does not support supervised services.");
      return run(services, ref);
    }

    describe() {
      // Global fallback capabilities; machine computers degrade graphically and callers
      // exclude them per computer where a graphical capability is required.
      return (
        options.fallbackSandbox?.describe() ?? {
          id: "machine",
          contractVersion: "1",
          adapterVersion: "0.1.0",
          capabilities: {
            graphical: false,
            pty: true,
            snapshots: false,
            takeover: false,
            persistentHome: true,
            multiScreen: false,
          },
        }
      );
    }

    private requireFallback(): SandboxProvider {
      if (!options.fallbackSandbox) {
        throw new Error("This deployment has no backend-local sandbox; every bot needs a machine");
      }
      return options.fallbackSandbox;
    }

    private route(computer: ComputerRef): { provider: SandboxProvider; ref: ComputerRef } {
      if (computer.kind !== "machine") {
        return { provider: this.requireFallback(), ref: computer };
      }
      const parsed = parseMachineBoundComputerId(computer.id);
      if (!parsed) {
        throw new Error(`Computer ${computer.id} is not machine-bound; refusing to route`);
      }
      return { provider: machineSandbox(parsed.machineId), ref: computer };
    }

    async provision(
      request: {
        botId: string;
        homePath: string;
        providerRef?: string;
        providerKind?: ComputerRef["kind"];
      },
      context: AdapterContext,
    ): Promise<ComputerRef> {
      const machineId = await machineForProvision(prisma, request.botId, context.spaceId);
      if (!machineId) return this.requireFallback().provision(request, context);
      return machineSandbox(machineId).provision(
        {
          botId: request.botId,
          homePath: request.homePath,
          ...(request.providerKind === "machine" && request.providerRef
            ? { providerRef: request.providerRef }
            : {}),
        },
        context,
      );
    }

    prepare(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.prepare(ref, context);
    }

    async *execute(
      computer: ComputerRef,
      request: CommandRequest,
      context: AdapterContext,
    ): AsyncIterable<ProcessEvent> {
      const { provider, ref } = this.route(computer);
      yield* provider.execute(ref, request, context);
    }

    connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.connectScreen(ref, request, context);
    }

    setScreenControl(
      computer: ComputerRef,
      interactive: boolean,
      context: AdapterContext,
      controlToken?: string,
    ) {
      const { provider, ref } = this.route(computer);
      return (
        provider.setScreenControl?.(ref, interactive, context, controlToken) ?? Promise.resolve()
      );
    }

    sendInput(
      computer: ComputerRef,
      input: ComputerInput,
      lease: ControlLeaseRef,
      context: AdapterContext,
    ) {
      const { provider, ref } = this.route(computer);
      return provider.sendInput(ref, input, lease, context);
    }

    observe(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.observe(ref, context);
    }

    act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.act(ref, request, context);
    }

    listFiles(computer: ComputerRef, directory: string, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.listFiles(ref, directory, context);
    }

    readFile(
      computer: ComputerRef,
      filePath: string,
      context: AdapterContext,
      limits?: { maxBytes?: number },
    ) {
      const { provider, ref } = this.route(computer);
      return provider.readFile(ref, filePath, context, limits);
    }

    writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.writeFile(ref, file, context);
    }

    exportWorkspace(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.exportWorkspace(ref, context);
    }

    importWorkspace(
      computer: ComputerRef,
      files: AsyncIterable<PortableFile>,
      context: AdapterContext,
    ) {
      const { provider, ref } = this.route(computer);
      return provider.importWorkspace(ref, files, context);
    }

    snapshot(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.snapshot(ref, context);
    }

    keepAlive(computer: ComputerRef) {
      const { provider, ref } = this.route(computer);
      return provider.keepAlive?.(ref) ?? Promise.resolve();
    }

    releaseScreen(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.releaseScreen?.(ref, context) ?? Promise.resolve();
    }

    stop(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.stop(ref, context);
    }

    destroy(computer: ComputerRef, context: AdapterContext) {
      const { provider, ref } = this.route(computer);
      return provider.destroy(ref, context);
    }
  }

  return {
    sandbox: new MachineRoutingSandbox(),
    host: {
      async start(scope: Readonly<AgentProcessScope>, signal: AbortSignal) {
        const machineId = await machineForRun(prisma, scope.botId, scope.spaceId);
        if (machineId) return machineHost(machineId).start(scope, signal);
        if (!options.fallbackHost) {
          throw new Error(
            "This deployment has no backend-local isolation host; every bot needs a machine",
          );
        }
        return options.fallbackHost.start(scope, signal);
      },
    },
  };
}
