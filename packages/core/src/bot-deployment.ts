import type { Machine, MachinePairing, MachineStatus } from "@rakazo/contracts";

export type { MachineStatus };
export type MachineSummary = Machine;
export type PairingStart = MachinePairing;

/** Presentation boundary; the server owns pairing, credentials, and relocation. */
export type MachineGateway = {
  list(): Promise<MachineSummary[]>;
  startPairing(name: string): Promise<PairingStart>;
  cancelPairing(pairingId: string): Promise<void>;
  revoke(machineId: string): Promise<void>;
  assignment(botId: string): Promise<string | null>;
  assign(botId: string, machineId: string | null): Promise<void>;
};

export function isPairedMachine(machine: MachineSummary): boolean {
  return machine.status === "online" || machine.status === "offline";
}

export function currentMachine(
  machineId: string | null | undefined,
  machines: MachineSummary[],
): MachineSummary | null {
  return machineId ? (machines.find((machine) => machine.id === machineId) ?? null) : null;
}

export function orderedMachineChoices(machines: MachineSummary[]): MachineSummary[] {
  return machines
    .filter(isPairedMachine)
    .sort(
      (left, right) =>
        Number(right.status === "online") - Number(left.status === "online") ||
        left.name.localeCompare(right.name),
    );
}

export type PairingPhase = "waiting" | "paired" | "expired";
export const PAIRING_POLL_INTERVAL_MS = 2_000;
export const PAIRING_EXPIRY_SLACK_MS = 5_000;

export function pairingPhase(
  expiresAt: string,
  now = Date.now(),
  slackMs = PAIRING_EXPIRY_SLACK_MS,
): PairingPhase {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry + slackMs < now ? "expired" : "waiting";
}

/** A desktop window can host a remote server; only the server origin matters. */
export function isLocalManagedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Quote both arguments because this command is copied into a shell. */
export function machinePairingCommand(origin: string, code: string): string {
  const quote = (value: string) => `'${value.split("'").join("'\\''")}'`;
  return `rakazo-runner pair --server ${quote(new URL(origin).origin)} --code ${quote(code)}`;
}

export type PairingView = MachinePairing & { phase: PairingPhase };
export type DeploymentSnapshot = {
  phase: "idle" | "loading" | "ready" | "error";
  machines: MachineSummary[];
  botMachineId: string | null;
  error: string | null;
  pairing: PairingView | null;
  saving: boolean;
};
export type ControllerOptions = { pollIntervalMs?: number; expirySlackMs?: number };

/** Shared web/mobile state; stale responses cannot overwrite newer user intent. */
export class BotDeploymentController {
  readonly #gateway: MachineGateway;
  readonly #botId: string;
  readonly #options: Required<ControllerOptions>;
  readonly #listeners = new Set<() => void>();
  #snapshot: DeploymentSnapshot = {
    phase: "idle",
    machines: [],
    botMachineId: null,
    error: null,
    pairing: null,
    saving: false,
  };
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #lifecycle = 0;
  #loadVersion = 0;
  #pairingVersion = 0;

  constructor(gateway: MachineGateway, botId: string, options: ControllerOptions = {}) {
    this.#gateway = gateway;
    this.#botId = botId;
    this.#options = {
      pollIntervalMs: options.pollIntervalMs ?? PAIRING_POLL_INTERVAL_MS,
      expirySlackMs: options.expirySlackMs ?? PAIRING_EXPIRY_SLACK_MS,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): DeploymentSnapshot => this.#snapshot;

  #patch(patch: Partial<DeploymentSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #isCurrent(lifecycle: number) {
    return !this.#disposed && lifecycle === this.#lifecycle;
  }

  /** React effect replay reconnects the same controller without accepting old requests. */
  start() {
    this.#disposed = false;
    this.#lifecycle++;
    this.#patch({ saving: false });
    void this.load();
    this.#schedulePoll();
  }

  async load(): Promise<void> {
    if (this.#disposed) return;
    const lifecycle = this.#lifecycle;
    const version = ++this.#loadVersion;
    this.#patch({
      phase: this.#snapshot.machines.length ? this.#snapshot.phase : "loading",
      error: null,
    });
    try {
      const [machines, botMachineId] = await Promise.all([
        this.#gateway.list(),
        this.#gateway.assignment(this.#botId),
      ]);
      if (this.#isCurrent(lifecycle) && version === this.#loadVersion) {
        this.#patch({ phase: "ready", machines, botMachineId });
      }
    } catch (error) {
      if (this.#isCurrent(lifecycle) && version === this.#loadVersion) {
        this.#patch({
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async choose(machineId: string | null): Promise<void> {
    if (this.#disposed || this.#snapshot.saving) return;
    const lifecycle = this.#lifecycle;
    this.#loadVersion++;
    this.#patch({ saving: true, error: null });
    try {
      await this.#gateway.assign(this.#botId, machineId);
      if (!this.#isCurrent(lifecycle)) return;
      this.#patch({ botMachineId: machineId });
      await this.load();
    } catch (error) {
      if (this.#isCurrent(lifecycle))
        this.#patch({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.#isCurrent(lifecycle)) this.#patch({ saving: false });
    }
  }

  async startPairing(name: string): Promise<void> {
    if (this.#disposed || this.#snapshot.saving) return;
    const lifecycle = this.#lifecycle;
    const version = ++this.#pairingVersion;
    const prior = this.#snapshot.pairing;
    this.#stopPoll();
    this.#patch({ saving: true, error: null, pairing: null });
    try {
      if (prior) await this.#gateway.cancelPairing(prior.pairingId);
      const start = await this.#gateway.startPairing(name);
      if (!this.#isCurrent(lifecycle) || version !== this.#pairingVersion) {
        await this.#gateway.cancelPairing(start.pairingId).catch(() => undefined);
        return;
      }
      this.#patch({ pairing: { ...start, phase: "waiting" } });
      this.#schedulePoll();
    } catch (error) {
      if (this.#isCurrent(lifecycle))
        this.#patch({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.#isCurrent(lifecycle)) this.#patch({ saving: false });
    }
  }

  #stopPoll() {
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  #schedulePoll() {
    if (this.#disposed || this.#pollTimer || this.#snapshot.pairing?.phase !== "waiting") return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#pollOnce();
    }, this.#options.pollIntervalMs);
  }

  async #pollOnce(): Promise<void> {
    const pairing = this.#snapshot.pairing;
    const version = this.#pairingVersion;
    if (!pairing) return;
    if (pairingPhase(pairing.expiresAt, Date.now(), this.#options.expirySlackMs) === "expired") {
      this.#patch({ pairing: { ...pairing, phase: "expired" } });
      return;
    }
    try {
      const machines = await this.#gateway.list();
      if (this.#disposed || version !== this.#pairingVersion) return;
      this.#patch({ machines });
      // Pairing ids identify the pending machine row, not any newly seen machine.
      if (
        machines.some((machine) => machine.id === pairing.pairingId && isPairedMachine(machine))
      ) {
        this.#patch({ pairing: { ...pairing, phase: "paired" } });
        return;
      }
    } catch {
      // A transient list failure does not erase the pairing or extend its expiry.
    }
    if (version === this.#pairingVersion) this.#schedulePoll();
  }

  acknowledgePairing() {
    this.#pairingVersion++;
    this.#stopPoll();
    this.#patch({ pairing: null });
    void this.load();
  }

  async cancelPairing(): Promise<void> {
    const pairing = this.#snapshot.pairing;
    const lifecycle = this.#lifecycle;
    this.#pairingVersion++;
    this.#stopPoll();
    this.#patch({ pairing: null });
    if (!pairing) return;
    try {
      await this.#gateway.cancelPairing(pairing.pairingId);
    } catch (error) {
      if (this.#isCurrent(lifecycle))
        this.#patch({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async revoke(machineId: string): Promise<void> {
    if (this.#disposed || this.#snapshot.saving) return;
    const lifecycle = this.#lifecycle;
    this.#loadVersion++;
    this.#patch({ saving: true, error: null });
    try {
      await this.#gateway.revoke(machineId);
      // Revocation is not consent to move work back onto the default machine.
      if (this.#isCurrent(lifecycle)) await this.load();
    } catch (error) {
      if (this.#isCurrent(lifecycle))
        this.#patch({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.#isCurrent(lifecycle)) this.#patch({ saving: false });
    }
  }

  dispose() {
    this.#disposed = true;
    this.#lifecycle++;
    this.#loadVersion++;
    this.#pairingVersion++;
    this.#stopPoll();
    this.#listeners.clear();
  }
}
