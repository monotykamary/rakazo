import {
  OfficeReplicaJournalBatchSchema,
  OfficeReplicaReturnSchema,
  type OfficeReplicaWork,
  type ProductEvent,
} from "@rakazo/contracts";
import {
  claimOfficeReplica,
  importOfficeReplicaJournal,
  OfficeReplicaJournalError,
  type PrismaClient,
  returnOfficeReplica,
} from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import type { MachineRunnerDeps } from "./machines.js";

const CLAIM_BODY_BYTES = 4 * 1024;
const JOURNAL_BODY_BYTES = 2 * 1024 * 1024;

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

export interface OfficeReplicaRouteDeps extends MachineRunnerDeps {
  prisma: PrismaClient;
  appendEvent: (input: {
    spaceId: string;
    threadId: string;
    botId: string;
    type: ProductEvent["type"];
    payload: Record<string, unknown>;
    runId?: string;
  }) => Promise<unknown>;
}

async function buildWork(
  prisma: PrismaClient,
  replica: {
    id: string;
    epoch: number;
    runId: string;
    botId: string;
    threadId: string;
    spaceId: string;
    leaseFence: number;
  },
): Promise<OfficeReplicaWork | null> {
  const run = await prisma.run.findUnique({
    where: { id: replica.runId },
    include: {
      task: { select: { prompt: true } },
      bot: { select: { instructions: true, computerId: true } },
    },
  });
  if (!run?.bot.computerId) return null;
  const messages = await prisma.message.findMany({
    where: { threadId: replica.threadId },
    orderBy: { seq: "desc" },
    take: 40,
    select: { role: true, blocks: true },
  });
  const history = [...messages].reverse().flatMap((message) => {
    if (message.role !== "user" && message.role !== "bot" && message.role !== "system") return [];
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const text = blocks
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const record = block as { kind?: string; text?: string };
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!text) return [];
    return [
      {
        role: message.role === "bot" ? ("assistant" as const) : (message.role as "user" | "system"),
        content: text.slice(0, 20_000),
      },
    ];
  });
  return {
    replicaId: replica.id,
    epoch: replica.epoch,
    runId: replica.runId,
    botId: replica.botId,
    threadId: replica.threadId,
    spaceId: replica.spaceId,
    computerId: run.bot.computerId,
    leaseFence: replica.leaseFence,
    prompt: run.task.prompt,
    instructions: run.bot.instructions,
    history,
    model: {
      provider: run.modelProvider ?? "unknown",
      id: run.modelId ?? "unknown",
    },
  };
}

export function mountOfficeReplicaRoutes(app: Hono, deps: OfficeReplicaRouteDeps): void {
  const { machines, prisma, appendEvent } = deps;

  app.post("/api/machines/runner/replicas/claim", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, CLAIM_BODY_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    if (!parseJsonObject(raw ?? "{}")) return c.json({ error: "Invalid JSON body." }, 400);
    const replica = await claimOfficeReplica(prisma, { machineId: machine.id });
    if (!replica) return c.json({ work: null });
    const work = await buildWork(prisma, replica);
    if (!work) return c.json({ work: null });
    return c.json({ work });
  });

  app.post("/api/machines/runner/replicas/journal", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, JOURNAL_BODY_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseJsonObject(raw ?? "");
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    const parsed = OfficeReplicaJournalBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid replica journal." }, 400);
    try {
      const verified = await importOfficeReplicaJournal(prisma, {
        replicaId: parsed.data.replicaId,
        machineId: machine.id,
        epoch: parsed.data.epoch,
        entries: parsed.data.entries,
        appendEvent: async (entry) => {
          if (entry.type === "heartbeat") return;
          const type = entry.payload.type;
          if (typeof type !== "string" || !type) return;
          const replica = await prisma.officeReplica.findUnique({
            where: { id: parsed.data.replicaId },
          });
          if (!replica) return;
          const { type: _type, ...payload } = entry.payload;
          await appendEvent({
            spaceId: replica.spaceId,
            threadId: replica.threadId,
            botId: replica.botId,
            runId: replica.runId,
            type: type as ProductEvent["type"],
            payload,
          });
        },
      });
      return c.json({ cursor: verified.cursor, head: verified.head });
    } catch (error) {
      if (error instanceof OfficeReplicaJournalError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.post("/api/machines/runner/replicas/return", async (c) => {
    const machine = await machines.authenticate(bearerToken(c.req.raw));
    if (!machine) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, CLAIM_BODY_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseJsonObject(raw ?? "");
    if (!body) return c.json({ error: "Invalid JSON body." }, 400);
    const parsed = OfficeReplicaReturnSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid replica return." }, 400);
    try {
      const result = await returnOfficeReplica(prisma, {
        replicaId: parsed.data.replicaId,
        machineId: machine.id,
        epoch: parsed.data.epoch,
        outcome: parsed.data.outcome,
        error: parsed.data.error,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof OfficeReplicaJournalError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });
}
