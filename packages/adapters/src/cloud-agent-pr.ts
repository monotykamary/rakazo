import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "@rakazo/core";
import { appendEventInTransaction, type PrismaClient } from "@rakazo/db";

export async function recordMergedCloudAgentPullRequest(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; prUrl: string; mergedAt?: Date },
) {
  const mergedAt = input.mergedAt ?? new Date();
  const agents = await prisma.cloudAgent.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      prUrl: input.prUrl,
      prMergedAt: null,
    },
  });
  for (const agent of agents) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.cloudAgent.updateMany({
        where: { id: agent.id, prMergedAt: null },
        data: { prMergedAt: mergedAt, version: { increment: 1 } },
      });
      if (!updated.count || !agent.messageId) return;
      const message = await tx.message.findFirst({
        where: { id: agent.messageId, threadId: agent.threadId },
      });
      if (!message) return;
      const nextBlock = cloudAgentBlockFromPayload({
        ...agent,
        agentId: agent.id,
        prMergedAt: mergedAt,
      });
      const blocks = (message.blocks as MessageBlock[]).map((block) =>
        block.kind === "cloud_agent" && block.agentId === agent.id ? nextBlock : block,
      );
      if (JSON.stringify(blocks) === JSON.stringify(message.blocks)) return;
      await tx.message.update({ where: { id: message.id }, data: { blocks } });
      await appendEventInTransaction(tx, {
        spaceId: agent.spaceId,
        threadId: agent.threadId,
        botId: agent.botId,
        type: "thread.cloud_agent",
        payload: { messageId: message.id, ...nextBlock },
      });
    });
  }
}
