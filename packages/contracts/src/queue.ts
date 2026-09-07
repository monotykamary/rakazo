import * as z from "zod";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_COUNT } from "./attachments.js";
import { Id } from "./ids.js";

export const QueueLaneSchema = z.enum(["steer", "followUp"]);
export const QueueImageSchema = z.object({
  type: z.literal("image"),
  data: z.string().max(ATTACHMENT_MAX_BASE64_LENGTH),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
const images = z.array(QueueImageSchema).max(ATTACHMENT_MAX_COUNT);
const text = z.string().max(100_000);
export const QueuePlacementSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["none", "unbound", "project"]),
  computerId: Id.nullable(),
  homeKey: z.string().nullable(),
  projectPath: z.string().nullable(),
  worktreePath: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export type QueuePlacement = z.infer<typeof QueuePlacementSchema>;

export const QueueAttachmentSchema = z.object({
  artifactId: Id,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative().optional(),
});
export const QueueTargetSchema = z.object({ participantId: Id }).strict();
export type QueueTarget = z.infer<typeof QueueTargetSchema>;
export const QueueControlCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("compact"),
      instructions: text.optional(),
      participantId: Id.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("participant-await"), participantId: Id }).strict(),
]);
export type QueueControlCommand = z.infer<typeof QueueControlCommandSchema>;
export type QueueControlResult = {
  outcome: "completed" | "rejected" | "uncertain";
  error?: string;
};
export const QueueRowSchema = z.object({
  id: Id,
  sequence: z.number().int().positive(),
  lane: QueueLaneSchema,
  text,
  images,
  paused: z.boolean().optional(),
  attachments: z.array(QueueAttachmentSchema).optional(),
  placement: QueuePlacementSchema.optional(),
  target: QueueTargetSchema.optional(),
});
export const QueuePatchSchema = z.object({
  text: text.optional(),
  images: images.optional(),
  lane: QueueLaneSchema.optional(),
  paused: z.boolean().optional(),
  removed: z.boolean().optional(),
});
export const QueueOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("enqueue"),
    lane: QueueLaneSchema,
    target: QueueTargetSchema.optional(),
    text,
    images: images.optional(),
    paused: z.boolean().optional(),
  }),
  z.object({ type: z.literal("edit-begin"), id: Id }),
  z.object({ type: z.literal("edit-select"), id: Id }),
  z.object({ type: z.literal("edit-patch"), patch: QueuePatchSchema }),
  z.object({ type: z.literal("edit-save") }),
  z.object({ type: z.literal("edit-cancel") }),
  z.object({ type: z.literal("remove"), id: Id }),
  z.object({ type: z.literal("bind-placement"), id: Id }).strict(),
  z.object({
    type: z.literal("reorder"),
    id: Id,
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ type: z.literal("lane"), id: Id, lane: QueueLaneSchema }),
  z.object({ type: z.literal("hold"), id: Id, paused: z.boolean() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("graceful-pause") }),
]);
export const QueueScopeSchema = z.object({ threadId: Id, botId: Id });
export const QueueSnapshotSchema = z.object({
  version: z.literal(1),
  sessionId: Id,
  revision: z.number().int().nonnegative(),
  rows: z.array(QueueRowSchema),
  identity: z.object({
    nextIdNumber: z.number().int().positive(),
    nextSequence: z.number().int().positive(),
  }),
  uncertainRowIds: z.array(Id),
  paused: z.boolean(),
  errorHold: z.boolean(),
  modes: z.object({
    steer: z.enum(["all", "one-at-a-time"]),
    followUp: z.enum(["all", "one-at-a-time"]),
  }),
  editing: z
    .object({ selectedId: Id, rows: z.array(QueueRowSchema.extend({ removed: z.boolean() })) })
    .optional(),
  inFlight: z.object({ attemptId: Id, rowIds: z.array(Id) }).optional(),
  compaction: z.enum(["manual", "threshold", "overflow"]).optional(),
  gracefulPausePending: z.boolean(),
});
export const QueueMutationSchema = QueueScopeSchema.extend({
  requestId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  operation: QueueOperationSchema,
});
export const QueueReplySchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  snapshot: QueueSnapshotSchema,
});
export type QueueOperation = z.infer<typeof QueueOperationSchema>;
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;
export type QueueMutation = z.infer<typeof QueueMutationSchema>;
export type QueueReply = z.infer<typeof QueueReplySchema>;
