import { QueueReplySchema, QueueSnapshotSchema } from "@rakazo/contracts";

export type ComposerQueueLane = "steer" | "followUp";

export function queueDraftError(mentions: number, replying: boolean): string | null {
  if (mentions && replying) return "Remove mentions and reply before queueing.";
  if (mentions) return "Remove mentions before queueing.";
  if (replying) return "Remove reply before queueing.";
  return null;
}

export async function enqueueComposerDraft({
  rpc,
  threadId,
  botId,
  groupId,
  lane,
  text,
  attachments,
  requestId,
}: {
  rpc: (path: string, input: Record<string, unknown>) => Promise<unknown>;
  threadId: string;
  botId: string;
  groupId?: string;
  lane: ComposerQueueLane;
  text: string;
  attachments: { name: string; mimeType: string; contentBase64: string }[];
  requestId: string;
}) {
  const artifactIds: string[] = [];
  for (const attachment of attachments) {
    const artifact = (await rpc("artifacts/create", {
      ...(groupId ? { groupId } : { botId }),
      ...attachment,
    })) as { id: string };
    artifactIds.push(artifact.id);
  }
  const snapshot = QueueSnapshotSchema.parse(await rpc("queue/list", { threadId, botId }));
  const reply = QueueReplySchema.parse(
    await rpc("queue/mutate", {
      threadId,
      botId,
      requestId,
      expectedRevision: snapshot.revision,
      operation: { type: "enqueue", lane, text, ...(artifactIds.length ? { artifactIds } : {}) },
    }),
  );
  if (!reply.ok) throw new Error(reply.error || "Could not queue message");
  return reply.snapshot;
}
