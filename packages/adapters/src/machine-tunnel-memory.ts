import type {
  MachineCommandRecord,
  MachineCommandScope,
  MachineRecord,
  MachineStore,
} from "@rakazo/contracts";

export interface MemoryMachineStoreOptions {
  /**
   * Mirror of the durable claim-time scope proof. Return false to tombstone
   * non-unscoped commands as if the run/computer had moved on.
   */
  scopeCheck?: (machineId: string, command: MachineCommandRecord) => Promise<boolean> | boolean;
  now?: () => Date;
}

/**
 * In-memory MachineStore with the same serialization semantics as the Prisma
 * store: at most one claim per command, revocation tombstones everything,
 * results are accepted exactly once. Single-threaded event loops make each
 * operation atomic without locks.
 */
export function createMemoryMachineStore(options: MemoryMachineStoreOptions = {}): MachineStore {
  const now = options.now ?? (() => new Date());
  const machines = new Map<string, MachineRecord>();
  const commands = new Map<string, MachineCommandRecord>();
  let commandSeq = 0;

  const expireStale = (machineId: string, stamp: Date) => {
    for (const command of commands.values()) {
      if (
        command.machineId === machineId &&
        (command.status === "pending" || command.status === "claimed") &&
        command.expiresAt.getTime() <= stamp.getTime()
      ) {
        commands.set(command.id, { ...command, status: "expired" });
      }
    }
  };

  return {
    async createMachine(input) {
      const record: MachineRecord = {
        id: `machine-${machines.size + 1}`,
        spaceId: input.spaceId,
        userId: input.userId,
        name: input.name,
        status: "pending",
        pairingCodeHash: input.pairingCodeHash,
        pairingExpiresAt: input.pairingExpiresAt,
        credentialHash: null,
        lastSeenAt: null,
        version: null,
        createdAt: input.now,
      };
      machines.set(record.id, record);
      return { ...record };
    },
    async listMachines(spaceId, userId) {
      return [...machines.values()]
        .filter((record) => record.spaceId === spaceId && record.userId === userId)
        .map((record) => ({ ...record }));
    },
    async getMachine(spaceId, userId, machineId) {
      const record = machines.get(machineId);
      return record && record.spaceId === spaceId && record.userId === userId
        ? { ...record }
        : null;
    },
    async getMachineById(machineId) {
      const record = machines.get(machineId);
      return record ? { ...record } : null;
    },
    async updateMachine(machineId, patch) {
      const record = machines.get(machineId);
      if (!record) return;
      machines.set(machineId, { ...record, ...patch });
    },
    async deleteMachine(machineId) {
      machines.delete(machineId);
      for (const [id, command] of commands) {
        if (command.machineId === machineId) commands.delete(id);
      }
    },
    async findMachineByPairingHash(hash) {
      for (const record of machines.values()) {
        if (record.pairingCodeHash === hash) return { ...record };
      }
      return null;
    },
    async findMachineByCredentialHash(hash) {
      for (const record of machines.values()) {
        if (record.credentialHash === hash) return { ...record };
      }
      return null;
    },
    async claimPairing(machineId, pairingCodeHash, patch) {
      const record = machines.get(machineId);
      if (!record || record.status !== "pending" || record.pairingCodeHash !== pairingCodeHash) {
        return false;
      }
      machines.set(machineId, {
        ...record,
        status: "paired",
        credentialHash: patch.credentialHash,
        pairingCodeHash: null,
        pairingExpiresAt: null,
        name: patch.name ?? record.name,
        version: patch.version ?? record.version,
        lastSeenAt: patch.now,
      });
      return true;
    },
    async revokeMachine(machineId) {
      const record = machines.get(machineId);
      if (!record) return;
      machines.set(machineId, {
        ...record,
        status: "revoked",
        credentialHash: null,
        pairingCodeHash: null,
        pairingExpiresAt: null,
      });
      for (const [id, command] of commands) {
        if (
          command.machineId === machineId &&
          (command.status === "pending" || command.status === "claimed")
        ) {
          commands.set(id, { ...command, status: "aborted" });
        }
      }
    },
    async createCommand(input) {
      commandSeq += 1;
      const record: MachineCommandRecord = {
        id: `command-${commandSeq}`,
        machineId: input.machineId,
        method: input.method,
        path: input.path,
        query: input.query,
        bodyBase64: input.bodyBase64,
        contentType: input.contentType,
        headersJson: input.headersJson,
        scopeKind: input.scope.kind,
        scopeSpaceId: input.scope.kind === "unscoped" ? null : input.scope.spaceId,
        scopeRunId:
          input.scope.kind === "agent"
            ? input.scope.runId
            : input.scope.kind === "computer"
              ? (input.scope.runId ?? null)
              : null,
        scopeBotId: input.scope.kind === "agent" ? input.scope.botId : null,
        scopeComputerId: input.scope.kind === "computer" ? input.scope.computerId : null,
        scopeLeaseOwner: input.scope.kind === "unscoped" ? null : (input.scope.leaseOwner ?? null),
        scopeLeaseFence: input.scope.kind === "unscoped" ? null : (input.scope.leaseFence ?? null),
        status: "pending",
        responseStatus: null,
        responseContentType: null,
        responseBodyBase64: null,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        claimedAt: null,
      };
      commands.set(record.id, record);
      return { ...record };
    },
    async getCommand(machineId, commandId) {
      const record = commands.get(commandId);
      return record && record.machineId === machineId ? { ...record } : null;
    },
    async claimNextCommand(machineId, stamp) {
      expireStale(machineId, stamp);
      const machine = machines.get(machineId);
      if (!machine || machine.status !== "paired" || !machine.credentialHash) return null;
      const pending = [...commands.values()]
        .filter((command) => command.machineId === machineId && command.status === "pending")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
      for (const candidate of pending) {
        if (candidate.scopeKind !== "unscoped" && options.scopeCheck) {
          const resolves = await options.scopeCheck(machineId, candidate);
          if (!resolves) {
            commands.set(candidate.id, { ...candidate, status: "aborted" });
            continue;
          }
        }
        const claimed = { ...candidate, status: "claimed" as const, claimedAt: stamp };
        commands.set(candidate.id, claimed);
        return { ...claimed };
      }
      return null;
    },
    async completeCommand(machineId, commandId, response, stamp) {
      const record = commands.get(commandId);
      if (!record || record.machineId !== machineId) return "missing";
      if (record.status === "completed" || record.status === "aborted") return "already";
      if (record.status !== "claimed") return "missing";
      if (record.scopeKind !== "unscoped" && options.scopeCheck) {
        const resolves = await options.scopeCheck(machineId, record);
        if (!resolves) {
          commands.set(commandId, { ...record, status: "aborted" });
          return "aborted";
        }
      }
      commands.set(commandId, {
        ...record,
        status: "completed",
        responseStatus: response.status,
        responseContentType: response.contentType,
        responseBodyBase64: response.bodyBase64,
        claimedAt: stamp,
      });
      void now;
      return "accepted";
    },
    async tombstoneCommand(machineId, commandId) {
      const record = commands.get(commandId);
      if (
        !record ||
        record.machineId !== machineId ||
        (record.status !== "pending" && record.status !== "claimed")
      ) {
        return false;
      }
      commands.set(commandId, { ...record, status: "aborted" });
      return true;
    },
    async expireMachineCommands(machineId, stamp) {
      expireStale(machineId, stamp);
    },
  };
}
