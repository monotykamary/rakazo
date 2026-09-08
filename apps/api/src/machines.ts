import { ORPCError } from "@orpc/server";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import {
  createMachinesService,
  type MachinesService,
  type MachinesServiceLimits,
  MachineTunnelError,
  toMachineDto,
} from "@rakazo/adapters";
import { type Actor, MACHINE_RESULT_REQUEST_MAX_BYTES, type MachineStore } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createPrismaMachineStore,
  type MachineAssignmentResult,
  machineAssignment,
  sweepExpiredMachineCommands,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { relocateBotMachine } from "./machine-relocation.js";

export class MachineRelocationBlockedError extends Error {
  constructor(message = "Stop the bot's active work before moving it to another machine.") {
    super(message);
    this.name = "MachineRelocationBlockedError";
  }
}

export interface MachineRunnerDeps {
  machines: MachinesService;
}

const MACHINE_PAIR_REQUEST_BYTES = 4 * 1024;
const MACHINE_SMALL_REQUEST_BYTES = 4 * 1024;
// Result bodies carry model payloads up to the runner's transport bound.
const resultBodyLimit = MACHINE_RESULT_REQUEST_MAX_BYTES;

/** Parses a bounded JSON body, rejecting null/non-object payloads with 400. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? (match[1] ?? null) : null;
}

function machineHttpError(
  c: { json: (body: unknown, status: number) => Response },
  error: unknown,
) {
  // Known transport/assignment decisions reach the runner verbatim; anything
  // else is flattened to an opaque message so raw persistence errors (which
  // can carry row payloads) never leak into a response.
  if (error instanceof MachineTunnelError || error instanceof MachineRelocationBlockedError) {
    return c.json({ error: error.message }, 400);
  }
  getLogger().error("machine runner request failed", error);
  return c.json({ error: "Machine request failed." }, 500);
}

/**
 * Outbound-only runner protocol. The machine polls this server; nothing here
 * ever opens a connection toward the machine. Every endpoint fail-closes on
 * unknown/revoked credentials, and commands are delivered exactly once.
 */
export function mountMachineRunnerRoutes(app: Hono, deps: MachineRunnerDeps): void {
  const { machines } = deps;

  app.post("/api/machines/runner/pair", async (c) => {
    const raw = await readBoundedBody(c.req.raw, MACHINE_PAIR_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseJsonObject(raw);
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    const code = typeof body.code === "string" ? body.code : "";
    const name = typeof body.name === "string" ? body.name.slice(0, 80) : undefined;
    const version = typeof body.version === "string" ? body.version.slice(0, 80) : undefined;
    try {
      const paired = await machines.pair({ code, name, version });
      return c.json({ machineId: paired.machineId, token: paired.token });
    } catch (error) {
      if (error instanceof MachineTunnelError) {
        const expired = /expired/i.test(error.message);
        const used = /used/i.test(error.message);
        return c.json({ error: error.message }, expired || used ? 410 : 401);
      }
      return machineHttpError(c, error);
    }
  });

  app.post("/api/machines/runner/poll", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MACHINE_SMALL_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    let waitMs = 0;
    const body = parseJsonObject(raw);
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    if (typeof body.waitMs === "number" && Number.isFinite(body.waitMs)) {
      waitMs = Math.max(0, Math.min(body.waitMs, 20_000));
    }
    try {
      const command = await machines.poll({ machineId: machine.id, waitMs });
      return c.json({ command });
    } catch (error) {
      return machineHttpError(c, error);
    }
  });

  app.post("/api/machines/runner/commands/:id/result", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, resultBodyLimit);
    if (raw === null) return c.json({ error: "Result exceeds the transport bound." }, 413);
    const body = parseJsonObject(raw);
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    const status = typeof body.status === "number" ? body.status : 0;
    const contentType = typeof body.contentType === "string" ? body.contentType : null;
    const bodyBase64 = typeof body.bodyBase64 === "string" ? body.bodyBase64 : null;
    try {
      const outcome = await machines.complete({
        machineId: machine.id,
        commandId: c.req.param("id"),
        response: { status, contentType, bodyBase64 },
      });
      if (outcome === "missing") return c.json({ error: "Unknown command" }, 404);
      if (outcome === "already") return c.json({ error: "Result already accepted" }, 409);
      return c.json({ ok: true, outcome });
    } catch (error) {
      return machineHttpError(c, error);
    }
  });

  app.post("/api/machines/runner/heartbeat", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MACHINE_SMALL_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    let version: string | undefined;
    const body = parseJsonObject(raw);
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    if (typeof body.version === "string") version = body.version.slice(0, 80);
    await machines.heartbeat({ machineId: machine.id, version });
    return new Response(null, { status: 204 });
  });
}

export interface MachineCompositionDeps {
  prisma: PrismaClient;
  store?: MachineStore;
  limits?: MachinesServiceLimits;
}

export function createMachineCompositionDeps(deps: MachineCompositionDeps): {
  machines: MachinesService;
  sweepExpiredMachineCommands: () => Promise<number>;
} {
  const store = deps.store ?? createPrismaMachineStore(deps.prisma);
  const machines = createMachinesService({ store, limits: deps.limits });
  return {
    machines,
    sweepExpiredMachineCommands: () => sweepExpiredMachineCommands(deps.prisma),
  };
}

function machineAssignmentError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  if (error instanceof MachineRelocationBlockedError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

export interface MachineAssignDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  /**
   * Kind for default (unassign) computer rows created by relocation; Main wires
   * it from the deployment's sandbox configuration. Defaults to "docker".
   */
  defaultComputerKind?: string;
}

/**
 * machines.assign: point a bot at a user-owned machine (or back to a default)
 * under the same computerSwitching latch the setComputer flow uses, so runs
 * cannot start mid-move. Every move is a verified relocation: the source
 * workspace is checkpointed, copied to a distinct target home key, verified
 * against a manifest, and only then atomically committed; the source is
 * retired gracefully and kept until the copy is proven. Queued dispatched-work
 * bindings keep their old placement and hold instead of rebinding.
 */
export async function assignBotMachine(
  deps: MachineAssignDeps,
  actor: Actor,
  input: { botId: string; machineId: string | null },
): Promise<MachineAssignmentResult> {
  const { prisma } = deps;
  // Existence is checked before the latch so a foreign or unknown bot reads as
  // NOT_FOUND instead of a latch conflict that would leak its state.
  const owned = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!owned) throw new ORPCError("NOT_FOUND");
  const claimed = await prisma.bot.updateMany({
    where: {
      id: input.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      computerSwitching: false,
    },
    data: { computerSwitching: true },
  });
  if (claimed.count !== 1) throw new ORPCError("CONFLICT");
  try {
    const bot = await prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      include: { computer: true },
    });
    if (!bot) throw new ORPCError("NOT_FOUND");
    const current = bot.computer;
    if (input.machineId !== null) {
      const machine = await prisma.machine.findFirst({
        where: {
          id: input.machineId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          status: "paired",
        },
        select: { id: true },
      });
      if (!machine) throw new ORPCError("NOT_FOUND");
      if (current?.machineId === machine.id) {
        return await machineAssignment(prisma, actor, { botId: bot.id });
      }
      return await relocateBotMachine(
        {
          prisma,
          sandbox: deps.sandbox,
          home: deps.home,
          defaultComputerKind: deps.defaultComputerKind,
        },
        actor,
        { botId: bot.id, current, machineId: machine.id },
      );
    }
    if (!current?.machineId) {
      return await machineAssignment(prisma, actor, { botId: bot.id });
    }
    return await relocateBotMachine(
      {
        prisma,
        sandbox: deps.sandbox,
        home: deps.home,
        defaultComputerKind: deps.defaultComputerKind,
      },
      actor,
      { botId: bot.id, current, machineId: null },
    );
  } catch (error) {
    throw machineAssignmentError(error);
  } finally {
    await prisma.bot.updateMany({
      where: { id: input.botId },
      data: { computerSwitching: false },
    });
  }
}

export { toMachineDto };
