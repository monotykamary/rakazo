import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "./cloud-agent.js";
import { ACTIVE_RUN_STATUSES } from "./run-state.js";

export const CLOUD_AGENT_PR_GRACE_MS = 24 * 60 * 60 * 1000;

export type ComposerOpsWorking = { id: string; botId: string; name: string };
export type ComposerOpsPullRequest = { id: string; title: string; url: string };
export type ComposerOpsListening = { id: string; name: string };

export type ComposerOps = {
  working: ComposerOpsWorking[];
  pullRequests: ComposerOpsPullRequest[];
  listening: ComposerOpsListening[];
};

export function composerOpsVisible(ops: ComposerOps) {
  return ops.working.length + ops.pullRequests.length + ops.listening.length > 0;
}

export function composerOps(input: {
  runs?: readonly { id: string; botId?: string; status: string }[];
  botNames?: Readonly<Record<string, string>>;
  messages?: readonly { blocks: readonly MessageBlock[] }[];
  routines?: readonly { id: string; name: string; active: boolean }[];
  now?: number;
}): ComposerOps {
  const botNames = input.botNames ?? {};
  return {
    working: (input.runs ?? []).flatMap((run) => {
      if (!run.botId || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return [];
      return [{ id: run.id, botId: run.botId, name: botNames[run.botId] ?? "" }];
    }),
    pullRequests: threadPullRequests(input.messages ?? [], input.now),
    listening: (input.routines ?? [])
      .filter((routine) => routine.active)
      .map((routine) => ({ id: routine.id, name: routine.name })),
  };
}

function threadPullRequests(
  messages: readonly { blocks: readonly MessageBlock[] }[],
  now = Date.now(),
): ComposerOpsPullRequest[] {
  const byAgent = new Map<string, ComposerOpsPullRequest>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "cloud_agent") continue;
      const url = cloudAgentHttpsUrl(block.prUrl);
      if (!url || !cloudAgentPrListed(block.prMergedAt, now)) continue;
      const id = block.agentId || url;
      byAgent.set(id, { id, title: block.title, url });
    }
  }
  return [...byAgent.values()];
}

export function cloudAgentPrListed(prMergedAt: string | undefined, now = Date.now()) {
  if (!prMergedAt) return true;
  const merged = Date.parse(prMergedAt);
  if (Number.isNaN(merged)) return true;
  return now - merged < CLOUD_AGENT_PR_GRACE_MS;
}
