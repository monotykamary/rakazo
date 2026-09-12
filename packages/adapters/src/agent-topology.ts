import { randomUUID } from "node:crypto";
import type { AgentRunTopology, AgentSessionParticipant, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { listPremoveQueue, mutatePremoveQueue, type PrismaClient, type ThreadEvents } from "@rakazo/db";
import { messageBot } from "./bot-messages.js";

type TopologyDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  jobs: JobPublisher;
};

const capabilities = ["steer", "followUp", "stop"] as const;

function sessionOf(bot: { id: string; name: string }, status = "idle"): AgentSessionParticipant {
  return { id: bot.id, name: bot.name, kind: "root", status, capabilities: [...capabilities] };
}

export async function enqueueFabricQueue(
  prisma: PrismaClient,
  actor: Actor,
  scope: { threadId: string; botId: string },
  input: { lane: "steer" | "followUp"; text: string; participantId?: string },
) {
  const snapshot = await listPremoveQueue(prisma, actor, {
    spaceId: actor.spaceId,
    threadId: scope.threadId,
    botId: scope.botId,
  });
  const reply = await mutatePremoveQueue(prisma, actor, {
    threadId: scope.threadId,
    botId: scope.botId,
    requestId: `fabric:${randomUUID()}`,
    expectedRevision: snapshot.revision,
    operation: {
      type: "enqueue",
      lane: input.lane,
      text: input.text,
      ...(input.participantId ? { target: { participantId: input.participantId } } : {}),
    },
  });
  if (!reply.ok) throw new Error(reply.error ?? "Queue mutation rejected");
}

export function createAgentRunTopology(
  deps: TopologyDeps,
  input: {
    actor: Actor;
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      userId: string;
      sourceMessageId?: string | null;
    };
    bot: { id: string; name: string };
    groupId?: string | null;
  },
  host?: {
    createPeer?: (request: {
      name: string;
      instructions?: string;
      task?: string;
    }) => Promise<{ id: string; name: string }>;
    removePeer?: (request: { id: string; name?: string }) => Promise<{ id: string; name: string }>;
    dispatchWork?: (request: {
      task: string;
      name?: string;
      cwd?: string;
      tools?: string[];
    }) => Promise<{ id: string; name: string }>;
    handoff?: (request: { id: string; message: string }) => Promise<{ id: string; name: string }>;
  },
): AgentRunTopology {
  const self = () => sessionOf(input.bot, "running");
  const list = async (peersOnly: boolean) => {
    const bots = await deps.prisma.bot.findMany({
      where: {
        spaceId: input.run.spaceId,
        userId: input.run.userId,
        archivedAt: null,
        temporary: false,
        ...(peersOnly ? { id: { not: input.bot.id } } : {}),
      },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    return bots.map((bot) => sessionOf(bot, bot.id === input.bot.id ? "running" : "idle"));
  };
  return {
    self,
    sessions: () => list(false),
    peers: () => list(true),
    async deliver({ id, operation, message, signal }) {
      signal?.throwIfAborted();
      if (id === input.bot.id || id === "main") {
        await enqueueFabricQueue(deps.prisma, input.actor, input.run, {
          lane: operation,
          text: message,
        });
        return self();
      }
      if (input.groupId && host?.handoff) {
        const handed = await host.handoff({ id, message });
        return sessionOf(handed, "running");
      }
      const sent = await messageBot(
        deps,
        input.run,
        input.bot,
        { bot_id: id, message, intent: "request" },
      );
      if (!sent.ok) throw new Error(sent.error);
      return sessionOf({ id: sent.botId, name: sent.name }, "running");
    },
    create: host?.createPeer
      ? async (request) => {
          request.signal?.throwIfAborted();
          return sessionOf(await host.createPeer!(request), "idle");
        }
      : undefined,
    remove: host?.removePeer
      ? async (request) => {
          request.signal?.throwIfAborted();
          return sessionOf(await host.removePeer!(request), "stopped");
        }
      : undefined,
    dispatch: host?.dispatchWork
      ? async (request) => {
          request.signal?.throwIfAborted();
          return sessionOf(await host.dispatchWork!(request), "running");
        }
      : undefined,
  };
}
