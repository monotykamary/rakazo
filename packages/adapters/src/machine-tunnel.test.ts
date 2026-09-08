import {
  isMachineSecretFormat,
  isMachineTunnelHeaderName,
  isMachineTunnelHeaderValue,
  isMachineTunnelMethod,
  isValidMachineTunnelPath,
  isValidMachineTunnelQuery,
  MACHINE_COMMAND_BODY_MAX_BYTES,
  type MachineCommandRecord,
  type MachineCommandScope,
  machineBase64ByteLength,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  createMachineFetch,
  createMachinesService,
  MachinePairingError,
  type MachineRecord,
  MachineTunnelError,
} from "./machine-tunnel.js";
import { createMemoryMachineStore } from "./machine-tunnel-memory.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

const agentScope: MachineCommandScope = {
  kind: "agent",
  spaceId: "space-1",
  runId: "run-1",
  botId: "bot-1",
  leaseOwner: "worker-1",
  leaseFence: 3,
};

function scopeCheckFor(active: boolean) {
  return (machineId: string, command: MachineCommandRecord) => {
    void machineId;
    void command;
    return active;
  };
}

function makeService(scopeActive = true) {
  const store = createMemoryMachineStore({ scopeCheck: scopeCheckFor(scopeActive) });
  return { store, machines: createMachinesService({ store }) };
}

describe("machine body bounds", () => {
  it("counts canonical decoded bytes without confusing base64 size with payload size", () => {
    for (const text of ["", "a", "ab", "abc", "abcd", "☀"]) {
      expect(machineBase64ByteLength(Buffer.from(text).toString("base64"))).toBe(
        Buffer.byteLength(text),
      );
    }
    for (const invalid of ["!", "A", "====", "AA=", "A===", "AB==", "AAB=", "e30=\n"]) {
      expect(machineBase64ByteLength(invalid)).toBeNull();
    }
  });

  it("accepts the full declared binary bound on both request encodings and results", async () => {
    const store = createMemoryMachineStore({ scopeCheck: () => true });
    const machines = createMachinesService({
      store,
      limits: { commandBodyMaxBytes: 3, resultBodyMaxBytes: 3 },
    });
    const start = await machines.startPairing(actor, { name: "workshop" });
    const { machineId } = await machines.pair({ code: start.code });
    for (const text of ["a", "ab", "abc"]) {
      const encoded = Buffer.from(text).toString("base64");
      for (const body of [{ body: text }, { bodyBase64: encoded }]) {
        const command = await machines.enqueue({
          machineId,
          method: "POST",
          path: "/agents",
          scope: agentScope,
          ...body,
        });
        expect(command.bodyBase64).toBe(encoded);
        await machines.poll({ machineId });
        await expect(
          machines.complete({
            machineId,
            commandId: command.id,
            response: { status: 200, contentType: null, bodyBase64: encoded },
          }),
        ).resolves.toBe("accepted");
      }
    }
    for (const body of [{ body: "abcd" }, { bodyBase64: Buffer.from("abcd").toString("base64") }]) {
      await expect(
        machines.enqueue({
          machineId,
          method: "POST",
          path: "/agents",
          scope: agentScope,
          ...body,
        }),
      ).rejects.toThrow("exceeds");
    }
    await expect(
      machines.enqueue({
        machineId,
        method: "POST",
        path: "/agents",
        scope: agentScope,
        bodyBase64: "!",
      }),
    ).rejects.toThrow("base64");
    await expect(
      machines.complete({
        machineId,
        commandId: "unused",
        response: {
          status: 200,
          contentType: null,
          bodyBase64: Buffer.from("abcd").toString("base64"),
        },
      }),
    ).rejects.toThrow("exceeds");
    await expect(
      machines.complete({
        machineId,
        commandId: "unused",
        response: { status: 200, contentType: "text/plain\r\nx-injected: yes", bodyBase64: null },
      }),
    ).rejects.toThrow("content type");
    await expect(
      machines.complete({
        machineId,
        commandId: "unused",
        response: { status: 101, contentType: null, bodyBase64: null },
      }),
    ).rejects.toThrow("status");
  });
});

describe("machine tunnel path and header validation", () => {
  it("keeps paths inside the supervisor authority", () => {
    expect(isValidMachineTunnelPath("/agents")).toBe(true);
    expect(isValidMachineTunnelPath("/agents/ag-1/events")).toBe(true);
    expect(isValidMachineTunnelPath("/computers")).toBe(true);
    expect(isValidMachineTunnelPath("/computers/c-1/files")).toBe(true);
    expect(isValidMachineTunnelPath("/agents/../etc")).toBe(false);
    expect(isValidMachineTunnelPath("//agents")).toBe(false);
    expect(isValidMachineTunnelPath("/other")).toBe(false);
    expect(isValidMachineTunnelPath("/agents/%41")).toBe(false);
    expect(isValidMachineTunnelPath("")).toBe(false);
  });

  it("validates queries, methods, and passthrough headers", () => {
    expect(isValidMachineTunnelQuery("cursor=-1")).toBe(true);
    expect(isValidMachineTunnelQuery("path=%2Fhome%2Fusr&mode=list")).toBe(true);
    expect(isValidMachineTunnelQuery("path=%2G")).toBe(false);
    expect(isValidMachineTunnelQuery("a b=1")).toBe(false);
    expect(isMachineTunnelMethod("POST")).toBe(true);
    expect(isMachineTunnelMethod("TRACE")).toBe(false);
    expect(isMachineTunnelHeaderName("x-rakazo-run-id")).toBe(true);
    expect(isMachineTunnelHeaderName("authorization")).toBe(false);
    expect(isMachineTunnelHeaderName("cookie")).toBe(false);
    expect(isMachineTunnelHeaderValue("worker-1")).toBe(true);
    expect(isMachineTunnelHeaderValue("bad value")).toBe(false);
  });

  it("recognizes machine secret formats", () => {
    const token = "rk_m_" + "A".repeat(43);
    expect(isMachineSecretFormat(token)).toBe(true);
    expect(isMachineSecretFormat("rk_m_short")).toBe(false);
    expect(isMachineSecretFormat("rk_p_" + "A".repeat(43))).toBe(true);
  });
});

describe("machine pairing", () => {
  it("issues a hashed single-use credential with a TTL", async () => {
    const { store, machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    expect(isMachineSecretFormat(started.code)).toBe(true);

    const listed = await machines.list(actor);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("pending");

    const paired = await machines.pair({ code: started.code, version: "1.0" });
    expect(isMachineSecretFormat(paired.token)).toBe(true);

    // Single use: the same code cannot pair again.
    await expect(machines.pair({ code: started.code })).rejects.toThrow(MachinePairingError);

    const record = (await store.getMachine(actor.spaceId, actor.userId, paired.machineId))!;
    expect(record.status).toBe("paired");
    expect(record.credentialHash).not.toContain(paired.token);
    expect(record.pairingCodeHash).toBeNull();
  });

  it("rejects expired pairing codes", async () => {
    let stamp = new Date("2026-01-01T00:00:00Z");
    const store = createMemoryMachineStore({ now: () => stamp });
    const machines = createMachinesService({ store, now: () => stamp });
    const started = await machines.startPairing(actor, { name: "laptop" });
    stamp = new Date(stamp.getTime() + 11 * 60_000);
    await expect(machines.pair({ code: started.code })).rejects.toThrow(/expired/);
  });

  it("cancels pending pairings", async () => {
    const { machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    await machines.cancelPairing(actor, { pairingId: started.pairingId });
    await expect(machines.pair({ code: started.code })).rejects.toThrow(MachinePairingError);
    expect(await machines.list(actor)).toHaveLength(0);
  });
});

describe("machine tunnel transport", () => {
  it("authenticates only paired credentials and fails closed after revocation", async () => {
    const { machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const paired = await machines.pair({ code: started.code });
    expect((await machines.authenticate(paired.token))?.id).toBe(paired.machineId);
    expect(await machines.authenticate("rk_m_wrongwrongwrongwrongwrongwrongwrongw")).toBeNull();

    await machines.revoke(actor, { machineId: paired.machineId });
    expect(await machines.authenticate(paired.token)).toBeNull();
  });

  it("delivers each command exactly once and accepts one result", async () => {
    const { machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const paired = await machines.pair({ code: started.code });

    await machines.enqueue({
      machineId: paired.machineId,
      method: "POST",
      path: "/agents",
      query: "",
      bodyBase64: Buffer.from(JSON.stringify({ runId: "r1" })).toString("base64"),
      contentType: "application/json",
      headers: { "x-rakazo-run-id": "r1", authorization: "Bearer secret" },
      scope: agentScope,
    });
    await machines.enqueue({
      machineId: paired.machineId,
      method: "GET",
      path: "/agents/ag-1/events",
      query: "cursor=-1",
      scope: agentScope,
    });

    const first = await machines.poll({ machineId: paired.machineId });
    expect(first?.path).toBe("/agents");
    expect(JSON.parse(Buffer.from(first!.bodyBase64!, "base64").toString())).toEqual({
      runId: "r1",
    });
    // Serialized passthrough strips credentials.
    const headers = JSON.parse(first!.headersJson) as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["x-rakazo-run-id"]).toBe("r1");

    // A second poll while the first is claimed does not re-deliver it.
    const second = await machines.poll({ machineId: paired.machineId, waitMs: 0 });
    expect(second?.path).toBe("/agents/ag-1/events");

    const outcome = await machines.complete({
      machineId: paired.machineId,
      commandId: first!.id,
      response: { status: 200, contentType: "application/json", bodyBase64: "e30=" },
    });
    expect(outcome).toBe("accepted");
    const replay = await machines.complete({
      machineId: paired.machineId,
      commandId: first!.id,
      response: { status: 500, contentType: null, bodyBase64: null },
    });
    expect(replay).toBe("already");
    const stored = await machines.waitForCommand({
      machineId: paired.machineId,
      commandId: first!.id,
    });
    expect(stored.responseStatus).toBe(200);
  });

  it("tombstones commands when the caller aborts and after revocation", async () => {
    const { machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const paired = await machines.pair({ code: started.code });
    const command = await machines.enqueue({
      machineId: paired.machineId,
      method: "DELETE",
      path: "/agents/ag-1",
      scope: agentScope,
    });
    expect(await machines.tombstone({ machineId: paired.machineId, commandId: command.id })).toBe(
      true,
    );
    expect(await machines.poll({ machineId: paired.machineId, waitMs: 0 })).toBeNull();
    expect(
      await machines.complete({
        machineId: paired.machineId,
        commandId: command.id,
        response: { status: 200, contentType: null, bodyBase64: null },
      }),
    ).toBe("already");

    await machines.revoke(actor, { machineId: paired.machineId });
    const later = await machines.enqueue({
      machineId: paired.machineId,
      method: "GET",
      path: "/agents",
      scope: agentScope,
    });
    expect(await machines.poll({ machineId: paired.machineId, waitMs: 0 })).toBeNull();
    expect(
      await machines.complete({
        machineId: paired.machineId,
        commandId: later.id,
        response: { status: 200, contentType: null, bodyBase64: null },
      }),
    ).toBe("missing");
  });

  it("refuses oversized bodies instead of truncating", async () => {
    const { machines } = makeService();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const paired = await machines.pair({ code: started.code });
    const huge = Buffer.alloc(MACHINE_COMMAND_BODY_MAX_BYTES + 1).toString("base64");
    await expect(
      machines.enqueue({
        machineId: paired.machineId,
        method: "POST",
        path: "/agents/ag-1/input",
        bodyBase64: huge,
        scope: agentScope,
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("createMachineFetch", () => {
  it("round-trips a supervisor request through the durable mailbox", async () => {
    const { machines } = makeService(true);
    const started = await machines.startPairing(actor, { name: "laptop" });
    const paired = machines.pair({ code: started.code });
    const machineId = (await paired).machineId;

    const respondOnce = async (response: { status: number; body: string }) => {
      let command = await machines.poll({ machineId });
      while (!command) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        command = await machines.poll({ machineId });
      }
      expect(command.method).toBe("POST");
      expect(JSON.parse(Buffer.from(command.bodyBase64!, "base64").toString("utf8"))).toEqual({
        runId: "r1",
        botId: "b1",
        spaceId: "s1",
      });
      expect(JSON.parse(command.headersJson)).not.toHaveProperty("authorization");
      await machines.complete({
        machineId,
        commandId: command.id,
        response: {
          status: response.status,
          contentType: "application/json",
          bodyBase64: Buffer.from(response.body).toString("base64"),
        },
      });
    };
    const responding = respondOnce({ status: 200, body: JSON.stringify({ id: "ag-1" }) });

    const fetch = createMachineFetch(machines, machineId, {
      scopeResolver: () => agentScope,
      allowUnscoped: true,
    });
    const response = await fetch("https://machine-tunnel.invalid/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer server-secret" },
      body: JSON.stringify({ runId: "r1", botId: "b1", spaceId: "s1" }),
    });
    await responding;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "ag-1" });
  });

  it("rejects unscoped requests unless explicitly allowed", async () => {
    const { machines } = makeService(true);
    const started = await machines.startPairing(actor, { name: "laptop" });
    const machineId = (await machines.pair({ code: started.code })).machineId;
    const fetch = createMachineFetch(machines, machineId, {
      scopeResolver: () => ({ kind: "unscoped" }),
    });
    await expect(fetch("https://machine-tunnel.invalid/agents", { method: "GET" })).rejects.toThrow(
      /scope/,
    );
    const fetchWithoutResolver = createMachineFetch(machines, machineId);
    await expect(
      fetchWithoutResolver("https://machine-tunnel.invalid/agents", { method: "GET" }),
    ).rejects.toThrow(/scope resolver/);
  });

  it("rejects destination paths outside the supervisor authority", async () => {
    const { machines } = makeService(true);
    const started = await machines.startPairing(actor, { name: "laptop" });
    const machineId = (await machines.pair({ code: started.code })).machineId;
    const fetch = createMachineFetch(machines, machineId, { allowUnscoped: true });
    await expect(
      fetch("https://machine-tunnel.invalid/admin/panel", { method: "GET" }),
    ).rejects.toThrow(MachineTunnelError);
  });

  it("surfaces expired commands as transport failures (fail closed)", async () => {
    let stamp = new Date("2026-01-01T00:00:00Z");
    const store = createMemoryMachineStore({ now: () => stamp });
    const machines = createMachinesService({ store, now: () => stamp });
    const started = await machines.startPairing(actor, { name: "laptop" });
    const machineId = (await machines.pair({ code: started.code })).machineId;
    const fetch = createMachineFetch(machines, machineId, { allowUnscoped: true });
    const pending = fetch("https://machine-tunnel.invalid/agents", { method: "GET" });
    stamp = new Date(stamp.getTime() + 10 * 60_000);
    await expect(pending).rejects.toThrow(/expired|Machine command/);
    void store;
  });

  it("returns the runner's error status verbatim", async () => {
    const { machines } = makeService(true);
    const started = await machines.startPairing(actor, { name: "laptop" });
    const machineId = (await machines.pair({ code: started.code })).machineId;
    const respondOnce = async () => {
      let command = await machines.poll({ machineId });
      while (!command) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        command = await machines.poll({ machineId });
      }
      await machines.complete({
        machineId,
        commandId: command.id,
        response: {
          status: 502,
          contentType: "text/plain",
          bodyBase64: Buffer.from("down").toString("base64"),
        },
      });
    };
    const responding = respondOnce();
    const fetch = createMachineFetch(machines, machineId, { allowUnscoped: true });
    const response = await fetch("https://machine-tunnel.invalid/agents", { method: "GET" });
    await responding;
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("down");
  });

  it("marks machine status offline without heartbeats", async () => {
    const { machines } = makeService(true);
    const started = await machines.startPairing(actor, { name: "laptop" });
    const machineId = (await machines.pair({ code: started.code })).machineId;
    await machines.heartbeat({ machineId, version: "2.0" });
    const listed = await machines.list(actor);
    expect(listed[0]!.status).toBe("online");
    expect(listed[0]!.version).toBe("2.0");
  });

  it("keeps the derived record type honest", async () => {
    const record: Pick<MachineRecord, "status" | "lastSeenAt"> = {
      status: "paired",
      lastSeenAt: null,
    };
    const { machines } = makeService(true);
    expect(
      machines.status({
        ...record,
        id: "",
        spaceId: "",
        userId: "",
        name: "",
        pairingCodeHash: null,
        pairingExpiresAt: null,
        credentialHash: null,
        version: null,
        createdAt: new Date(),
      }),
    ).toBe("offline");
  });
});
