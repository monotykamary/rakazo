import * as z from "zod";

// Exact identities only. Do not pass network-supplied globs to upstream's backtracking matcher.
const identity = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in stored model identities.
      /^[^*?\u0000-\u001f\u007f]+$/,
    );
export const ModelHideRuleSchema = z
  .object({
    provider: identity(100),
    model: identity(300).optional(),
  })
  .strict();
export type ModelHideRule = z.infer<typeof ModelHideRuleSchema>;
export const ModelVisibilitySchema = z
  .object({
    hide: z.array(ModelHideRuleSchema).max(100),
  })
  .strict();
export type ModelVisibility = z.infer<typeof ModelVisibilitySchema>;

/** Canonical provider/model identity, never a worker's rakazo-broker proxy identity. */
export function isModelHidden(
  visibility: ModelVisibility,
  provider: string,
  modelId: string,
): boolean {
  return visibility.hide.some(
    (rule) => rule.provider === provider && (rule.model === undefined || rule.model === modelId),
  );
}

export class ModelHiddenError extends Error {
  constructor() {
    super("This model is hidden. Unhide it in model settings or choose another model.");
    this.name = "ModelHiddenError";
  }
}

export function assertModelVisible(
  visibility: ModelVisibility,
  provider: string,
  modelId: string,
): void {
  if (isModelHidden(visibility, provider, modelId)) throw new ModelHiddenError();
}
