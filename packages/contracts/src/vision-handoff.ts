import * as z from "zod";

// Exact identities only. Do not pass network-supplied globs to the describer.
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

export const VisionHandoffSchema = z
  .object({
    enabled: z.boolean(),
    visionModel: z
      .string()
      .trim()
      .min(3)
      .max(401)
      .regex(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in stored model identities.
        /^[^*?\u0000-\u001f\u007f]+\/[^*?\u0000-\u001f\u007f]+$/,
      )
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && !value.visionModel) {
      ctx.addIssue({ code: "custom", message: "Vision model required when enabled" });
    }
  });
export type VisionHandoff = z.infer<typeof VisionHandoffSchema>;

export const DEFAULT_VISION_HANDOFF: VisionHandoff = { enabled: false, visionModel: null };

export function parseVisionModelRef(ref: string | null): { provider: string; id: string } | null {
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  const provider = identity(100).safeParse(ref.slice(0, slash));
  const id = identity(300).safeParse(ref.slice(slash + 1));
  if (!provider.success || !id.success) return null;
  return { provider: provider.data, id: id.data };
}

export function formatVisionModelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}
