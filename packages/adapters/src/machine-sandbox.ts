import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ComputerServicePreviewRequest,
  ComputerServicePreviewResponse,
  ComputerServiceSpec,
  ComputerServicesCapability,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "./docker-sandbox.js";

export const MACHINE_REF_PREFIX = "machine:";
export const MACHINE_TUNNEL_SUPERVISOR_BASE = "http://machine-supervisor.rakazo-internal";
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidMachineId(machineId: string): boolean {
  return MACHINE_ID_PATTERN.test(machineId);
}

export function machineBoundComputerId(machineId: string, computerId: string): string {
  if (!isValidMachineId(machineId)) throw new Error("Invalid machine identifier");
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(computerId)) throw new Error("Invalid computer identifier");
  return `${MACHINE_REF_PREFIX}${machineId}:${computerId}`;
}

export function parseMachineBoundComputerId(
  value: string,
): { machineId: string; computerId: string } | undefined {
  if (!value.startsWith(MACHINE_REF_PREFIX)) return undefined;
  const rest = value.slice(MACHINE_REF_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return undefined;
  const machineId = rest.slice(0, separator);
  const computerId = rest.slice(separator + 1);
  if (!isValidMachineId(machineId) || !/^[A-Za-z0-9._~-]{1,256}$/.test(computerId))
    return undefined;
  return { machineId, computerId };
}

export interface MachineSandboxOptions {
  /** Stable machine identity from the backend; machine-bound refs embed it and never retarget. */
  machineId: string;
  /** Machine-bound fetch from the backend tunnel (createMachineFetch); transport failure fails closed. */
  fetch: typeof fetch;
  /**
   * Resolve another machine's provider so machine-bound refs survive bot reassignment:
   * cleanup always runs on the machine that owns the ref, never by retargeting.
   */
  resolveMachine?: (machineId: string) => SandboxProvider | undefined;
}

export class MachineSandboxProvider implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  private readonly machineId: string;
  private readonly resolveMachine: MachineSandboxOptions["resolveMachine"];
  private readonly inner: DockerSandboxProvider;

  constructor(options: MachineSandboxOptions) {
    if (!isValidMachineId(options.machineId)) throw new Error("Invalid machine identifier");
    this.machineId = options.machineId;
    this.resolveMachine = options.resolveMachine;
    // The machine runner substitutes its own local supervisor secret, so no bearer leaves here.
    this.inner = new DockerSandboxProvider(MACHINE_TUNNEL_SUPERVISOR_BASE, "", {
      fetch: options.fetch,
      omitAuthorization: true,
    });
    this.pageBrowser = (computer, request, context) => {
      const { provider, ref } = this.target(computer);
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
  }

  describe() {
    const inner = this.inner.describe();
    return {
      ...inner,
      id: "machine",
      capabilities: {
        ...inner.capabilities,
        // Screen streaming needs WebSockets, which the HTTP tunnel does not carry yet.
        // Degrade explicitly instead of returning an unreachable screen URL.
        graphical: false,
        takeover: false,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const created = await this.inner.provision(request, context);
    return {
      id: machineBoundComputerId(this.machineId, created.id),
      botId: created.botId,
      kind: "machine",
      providerRef: machineBoundComputerId(this.machineId, created.providerRef),
      fresh: created.fresh,
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.prepare(ref, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const { provider, ref } = this.target(computer);
    yield* provider.execute(ref, request, context);
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    this.requireOwn(computer);
    // Remote screen streaming is unsupported until the tunnel carries WebSockets.
    // Callers treat a null URL as the documented degraded state.
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const { provider, ref } = this.target(computer);
    await provider.setScreenControl?.(ref, interactive, context, controlToken);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.sendInput(ref, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const { provider, ref } = this.target(computer);
    return provider.observe(ref, context);
  }

  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<{ completed: number; observation?: ComputerObservation }> {
    const { provider, ref } = this.target(computer);
    return provider.act(ref, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const { provider, ref } = this.target(computer);
    return provider.listFiles(ref, directory, context);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const { provider, ref } = this.target(computer);
    return provider.readFile(ref, filePath, context, options);
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.writeFile(ref, file, context);
  }

  // Portable workspace transfer over the tunnel: the remote home is node-local,
  // so exports and imports must never read backend host paths.
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const { provider, ref } = this.target(computer);
    yield* provider.exportWorkspace(ref, context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.importWorkspace(ref, files, context);
  }

  async snapshot(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<{ id: string; createdAt: string }> {
    const { provider, ref } = this.target(computer);
    return provider.snapshot(ref, context);
  }

  // Service control rides the same tunnel transport; machine-bound refs are
  // translated exactly like every other computer call and never retargeted.
  private readonly serviceCalls = {
    list: (computer: ComputerRef, context: AdapterContext) =>
      this.withServices(computer, (services, ref) => services.list(ref, context)),
    declare: (computer: ComputerRef, spec: ComputerServiceSpec, context: AdapterContext) =>
      this.withServices(computer, (services, ref) => services.declare(ref, spec, context)),
    stop: (computer: ComputerRef, name: string, context: AdapterContext) =>
      this.withServices(computer, (services, ref) => services.stop(ref, name, context)),
    restart: (computer: ComputerRef, name: string, context: AdapterContext) =>
      this.withServices(computer, (services, ref) => services.restart(ref, name, context)),
    remove: (computer: ComputerRef, name: string, context: AdapterContext) =>
      this.withServices(computer, (services, ref) => services.remove(ref, name, context)),
    preview: (
      computer: ComputerRef,
      request: ComputerServicePreviewRequest,
      context: AdapterContext,
    ): Promise<ComputerServicePreviewResponse> =>
      this.withServices(computer, (services, ref) => services.preview(ref, request, context)),
  };

  private async withServices<R>(
    computer: ComputerRef,
    run: (services: ComputerServicesCapability, ref: ComputerRef) => Promise<R>,
  ): Promise<R> {
    const { provider, ref } = this.target(computer);
    const services = provider.services;
    if (!services) throw new Error("This computer does not support supervised services.");
    return run(services, ref);
  }

  readonly services: ComputerServicesCapability = {
    list: this.serviceCalls.list,
    declare: this.serviceCalls.declare,
    stop: this.serviceCalls.stop,
    restart: this.serviceCalls.restart,
    remove: this.serviceCalls.remove,
    preview: this.serviceCalls.preview,
  };

  async keepAlive(computer: ComputerRef): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.keepAlive?.(ref);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.releaseScreen?.(ref, context);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.stop(ref, context);
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const { provider, ref } = this.target(computer);
    await provider.destroy(ref, context);
  }

  private requireOwn(computer: ComputerRef) {
    const parsed = parseMachineBoundComputerId(computer.id);
    if (!parsed || parsed.machineId !== this.machineId) {
      throw new Error(`Computer ${computer.id} is bound to a different machine`);
    }
  }

  /**
   * Machine-bound refs route only to the machine that created them. A foreign ref is
   * delegated to that machine's own provider for cleanup, or fails closed: never retargeted.
   */
  private target(computer: ComputerRef): { provider: SandboxProvider; ref: ComputerRef } {
    const parsed = parseMachineBoundComputerId(computer.id);
    if (!parsed) {
      throw new Error(`Computer ${computer.id} is not machine-bound; refusing to route`);
    }
    if (parsed.machineId === this.machineId) {
      return {
        provider: this.inner,
        ref: { ...computer, id: parsed.computerId },
      };
    }
    const foreign = this.resolveMachine?.(parsed.machineId);
    if (!foreign) {
      throw new Error(
        `Computer ${computer.id} is bound to another machine; cleanup must use that machine's provider`,
      );
    }
    return { provider: foreign, ref: computer };
  }
}
