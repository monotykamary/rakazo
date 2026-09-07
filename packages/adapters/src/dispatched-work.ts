import type { JobPublisher } from "@rakazo/adapter-kit";
import { DispatchWorkInput, type WorkLink, WorkProjectPath } from "@rakazo/contracts";
import {
  assertModelVisibleForOwner,
  createRepos,
  getWorkReceipt,
  type PrismaClient,
  type ThreadEvents,
  WorkScopeError,
} from "@rakazo/db";
import { messageBot } from "./bot-messages.js";

// Fixed read-only metadata probe on the authorized computer, never the API host.
const CANONICAL_PATH_PROGRAM = String.raw`
import json, os, sys
try:
    root = os.path.realpath(os.getcwd())
    requested = sys.argv[1]
    resolved = os.path.realpath(requested)
    if os.path.commonpath([root, resolved]) != root:
        raise ValueError()
    if sys.argv[2] == 'directory' and not os.path.isdir(resolved):
        raise ValueError()
    print(json.dumps(os.path.relpath(resolved, root)))
except Exception:
    sys.exit(1)
`;
export async function canonicalComputerPath(
  path: string,
  execute: (argv: string[]) => Promise<{ stdout: string; code: number }>,
  directory = true,
): Promise<string> {
  WorkProjectPath.parse(path);
  const result = await execute([
    "python3",
    "-I",
    "-c",
    CANONICAL_PATH_PROGRAM,
    path,
    directory ? "directory" : "path",
  ]);
  if (result.code !== 0 || result.stdout.length > 8192)
    throw new WorkScopeError("Project path is unavailable or outside the authorized computer.");
  let canonical: unknown;
  try {
    canonical = JSON.parse(result.stdout);
  } catch {
    throw new WorkScopeError("Project path could not be verified.");
  }
  const verified = WorkProjectPath.parse(canonical);
  if (verified !== canonical) throw new WorkScopeError("Project path could not be verified.");
  return verified;
}

export async function dispatchWork(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: Pick<ThreadEvents, "notify"> },
  source: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    sourceMessageId?: string | null;
  },
  raw: unknown,
  requestKey: string,
  placement: { computerId: string; homeKey: string; projectPath: string; worktreePath?: string },
) {
  const input = DispatchWorkInput.parse(raw);
  const existing = await deps.prisma.dispatchedWork.findUnique({
    where: { spaceId_requestKey: { spaceId: source.spaceId, requestKey } },
  });
  if (existing) {
    if (
      existing.userId !== source.userId ||
      existing.parentBotId !== source.botId ||
      existing.parentRunId !== source.id
    )
      throw new WorkScopeError("Work receipt belongs to another scope.");
    return {
      ok: true as const,
      replayed: true as const,
      ...(await getWorkReceipt(deps.prisma, existing.id)),
    };
  }
  const parent = await deps.prisma.bot.findFirst({
    where: {
      id: source.botId,
      spaceId: source.spaceId,
      userId: source.userId,
      temporary: false,
      archivedAt: null,
      computerSwitching: false,
      computerId: placement.computerId,
      computer: { homeKey: placement.homeKey },
    },
  });
  const active = await deps.prisma.run.findFirst({
    where: {
      id: source.id,
      spaceId: source.spaceId,
      userId: source.userId,
      botId: source.botId,
      threadId: source.threadId,
      status: "running",
    },
  });
  if (!parent || !active) throw new WorkScopeError("Source project authority changed.");
  const model = input.model ?? {
    provider: active.modelProvider ?? parent.modelProvider,
    modelId: active.modelId ?? parent.modelId,
    thinkingLevel: parent.thinkingLevel,
  };
  if (!model.provider || !model.modelId)
    throw new WorkScopeError("Choose a model before dispatching work.");
  await assertModelVisibleForOwner(deps.prisma, source, model.provider, model.modelId);
  let worker: { id: string; name: string; threadId: string };
  const spawnKey = `work:${requestKey}`;
  try {
    worker = await createRepos(deps.prisma).createBot(
      { userId: source.userId, spaceId: source.spaceId, email: "", isDeploymentOwner: false },
      {
        name: input.name,
        title: "Project worker",
        description: "",
        instructions: [
          "You are a temporary worker for one dispatched project task. Work only in your captured project/worktree. Do not create bots, broaden tools, use graphical controls, or leave background processes behind. Return the actual result, checks and failures concisely; the backend reports it to your coordinator automatically.",
          input.instructions,
        ]
          .filter(Boolean)
          .join("\n\n"),
        notifyOnFinish: false,
        temporary: true,
        parentBotId: parent.id,
        spawnKey,
        modelProvider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
      },
    );
  } catch (error) {
    const previous = await deps.prisma.bot.findUnique({
      where: { spaceId_spawnKey: { spaceId: source.spaceId, spawnKey } },
      include: { thread: true },
    });
    if (
      !previous ||
      !previous.thread ||
      !previous.temporary ||
      previous.archivedAt ||
      previous.parentBotId !== parent.id ||
      previous.userId !== source.userId ||
      previous.computerId !== placement.computerId
    )
      throw error;
    worker = { id: previous.id, name: previous.name, threadId: previous.thread.id };
  }
  const sent = await messageBot(
    deps,
    source,
    parent,
    {
      bot_id: worker.id,
      message: input.task,
      intent: "request",
      deliveryKey: `work:${requestKey}`,
    },
    {
      onQueued: async (tx, receipt): Promise<WorkLink> => {
        // Recheck the authority inside the transaction that commits the task and its wake.
        const authorized = await tx.bot.findFirst({
          where: {
            id: parent.id,
            userId: source.userId,
            spaceId: source.spaceId,
            archivedAt: null,
            temporary: false,
            computerSwitching: false,
            computerId: placement.computerId,
            computer: { homeKey: placement.homeKey },
          },
          select: { id: true },
        });
        if (!authorized) throw new WorkScopeError("Source project authority changed.");
        const work = await tx.dispatchedWork.create({
          data: {
            ...placement,
            spaceId: source.spaceId,
            userId: source.userId,
            parentBotId: parent.id,
            parentThreadId: source.threadId,
            parentRunId: source.id,
            workerBotId: worker.id,
            taskId: receipt.taskId,
            runId: receipt.runId,
            requestKey,
            tools: [...new Set(input.tools)],
          },
        });
        return {
          id: work.id,
          taskId: receipt.taskId,
          runId: receipt.runId,
          threadId: receipt.threadId,
          workerId: worker.id,
          name: worker.name,
          projectPath: work.projectPath,
          worktreePath: work.worktreePath,
        };
      },
    },
  );
  if (!sent.ok) throw new WorkScopeError(sent.error);
  const work = await deps.prisma.dispatchedWork.findUniqueOrThrow({
    where: { spaceId_requestKey: { spaceId: source.spaceId, requestKey } },
  });
  return { ok: true as const, ...(await getWorkReceipt(deps.prisma, work.id)) };
}
