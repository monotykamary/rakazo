import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { findDefaultModelCredential } from "@rakazo/db";

export class ModelConnectionUnavailableError extends Error {
  constructor() {
    super("Model connection unavailable");
    this.name = "ModelConnectionUnavailableError";
  }
}

/** Deployment auth is available to pins only for its explicitly configured default identity. */
export function matchesDeploymentModel(
  provider: string | undefined,
  modelId: string | undefined,
  deployment?: { provider: string; model: string } | null,
): boolean {
  return Boolean(deployment && provider === deployment.provider && modelId === deployment.model);
}

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && bot.modelId);
  // A missing connection must not turn an explicit pin into a different model.
  const credential = hasOverride ? overrideCredential : defaultCredential;
  return {
    provider:
      (hasOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id:
      (hasOverride ? bot!.modelId : null) ??
      credential?.defaultModel ??
      settings?.defaultModelId ??
      deployment?.model,
    credential,
    thinkingLevel: (bot?.thinkingLevel as AgentRunRequest["model"]["thinkingLevel"]) ?? null,
  };
}
