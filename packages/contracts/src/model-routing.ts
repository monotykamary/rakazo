import * as z from "zod";
import { Id } from "./ids.js";

// Same-provider account rotation is separate from explicit cross-model fallback.
export const ModelRoutingTargetSchema = z.object({
  credentialId: Id,
  modelId: z.string().trim().min(1).max(300),
});
export const ModelRoutingSchema = z
  .object({
    version: z.literal(1),
    strategy: z.enum(["ordered", "round-robin"]),
    credentialIds: z.array(Id).min(1).max(20),
    modelId: z.string().trim().min(1).max(300),
    fallbacks: z.array(ModelRoutingTargetSchema).max(20),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.credentialIds).size !== value.credentialIds.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate routing credential",
        path: ["credentialIds"],
      });
  });
export const ModelRoutingGetInputSchema = z.object({ credentialId: Id });
export const ModelRoutingSetInputSchema = z.object({
  credentialId: Id,
  routing: ModelRoutingSchema.nullable(),
});
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;
