import { isValidMachineId, MACHINE_TUNNEL_SUPERVISOR_BASE } from "./machine-sandbox.js";
import type { AgentProcessHost, AgentProcessScope } from "./pi-rpc-protocol.js";
import { SupervisorAgentProcessHost } from "./pi-supervisor-client.js";

export interface MachineAgentHostOptions {
  /** Stable machine identity from the backend; Pi processes only ever start on this machine. */
  machineId: string;
  /** Machine-bound fetch from the backend tunnel (createMachineFetch); transport failure fails closed. */
  fetch: typeof fetch;
}

/**
 * Runs isolated Pi agent processes on one assigned machine. There is deliberately no
 * fallback host: when the machine is disconnected, run starts fail closed instead of
 * silently landing on the backend's local supervisor.
 */
export class MachineAgentProcessHost implements AgentProcessHost {
  private readonly inner: SupervisorAgentProcessHost;

  constructor(options: MachineAgentHostOptions) {
    if (!isValidMachineId(options.machineId)) throw new Error("Invalid machine identifier");
    // The machine runner substitutes its own local supervisor secret, so no bearer leaves here.
    this.inner = new SupervisorAgentProcessHost({
      baseUrl: MACHINE_TUNNEL_SUPERVISOR_BASE,
      token: "",
      fetch: options.fetch,
      omitAuthorization: true,
    });
  }

  start(scope: Readonly<AgentProcessScope>, signal: AbortSignal) {
    return this.inner.start(scope, signal);
  }
}
