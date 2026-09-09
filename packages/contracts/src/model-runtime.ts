import * as z from "zod";
import { ModelCatalogEntrySchema } from "./domain.js";
import { Id } from "./ids.js";
import {
  ModelSelectionSchema,
  ModelSelectionScopeSchema,
  ModelSelectionStatusSchema,
} from "./model-selection.js";

const ModelRuntimeRefreshSchema = z.object({ refresh: z.boolean().optional() });

export const ModelRuntimeScopeSchema = z.union([
  ModelRuntimeRefreshSchema.strict(),
  ModelRuntimeRefreshSchema.extend({ botId: Id }).strict(),
  ModelSelectionScopeSchema.extend({ refresh: z.boolean().optional() }).strict(),
]);
export type ModelRuntimeScope = z.infer<typeof ModelRuntimeScopeSchema>;

export const ModelRuntimeAvailabilitySchema = z.object({
  status: z.enum(["available", "unavailable"]),
  error: z.string().nullable(),
});

export const ModelRuntimeSnapshotSchema = z.object({
  catalog: z.array(ModelCatalogEntrySchema),
  profileDefault: ModelSelectionSchema.nullable(),
  current: ModelSelectionSchema.nullable(),
  selection: ModelSelectionStatusSchema.nullable(),
  availability: ModelRuntimeAvailabilitySchema,
});
export type ModelRuntimeSnapshot = z.infer<typeof ModelRuntimeSnapshotSchema>;
