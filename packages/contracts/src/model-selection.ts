import * as z from "zod";
import { Id } from "./ids.js";

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** Public identity only. Credentials and connection configuration remain in Pi. */
export const ModelSelectionSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(300),
    thinkingLevel: ThinkingLevelSchema.nullable(),
  })
  .strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export const ModelSelectionStatusSchema = z.object({
  requested: ModelSelectionSchema.nullable(),
  effective: ModelSelectionSchema.nullable(),
  status: z.enum(["pending", "applied", "failed"]),
  error: z.string().nullable(),
});
export type ModelSelectionStatus = z.infer<typeof ModelSelectionStatusSchema>;
export const ModelSelectionScopeSchema = z
  .object({
    botId: Id,
    threadId: Id,
    participantId: Id.optional(),
  })
  .strict();
export const WorkerModelSelectionInputSchema = ModelSelectionScopeSchema.extend({
  selection: ModelSelectionSchema.nullable(),
}).strict();
export function sameModelSelection(a: ModelSelection | null, b: ModelSelection | null) {
  return (
    a?.provider === b?.provider &&
    a?.modelId === b?.modelId &&
    a?.thinkingLevel === b?.thinkingLevel
  );
}
