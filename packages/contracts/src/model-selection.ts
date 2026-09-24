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

/** Treat accidental serialization of absent IDs as unset, never as a model pin. */
export function usableModelId(value: string | null | undefined): string | null {
  const id = value?.trim();
  return !id || id === "null" || id === "undefined" ? null : id;
}

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => usableModelId(value) !== null, "Invalid model ID");

/** Public identity only. Credentials and connection configuration remain in Pi. */
export const ModelSelectionSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    modelId: ModelIdSchema,
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
