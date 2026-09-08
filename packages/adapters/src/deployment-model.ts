import path from "node:path";

export const LOCAL_PI_DEPLOYMENT_MODEL = { provider: "pi-local", model: "default" } as const;

export function resolveLocalPiRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
  dataDir = env.DATA_DIR ?? "./data",
): { command: string; cwd: string; sessionDir: string } | null {
  if (env.AGENT_RUNTIME !== "pi-local") return null;
  if (env.RAKAZO_TRUST_LOCAL_PI !== "1") {
    throw new Error("AGENT_RUNTIME=pi-local requires RAKAZO_TRUST_LOCAL_PI=1");
  }
  if (env.SANDBOX_PROVIDER !== "desktop") {
    throw new Error("AGENT_RUNTIME=pi-local requires SANDBOX_PROVIDER=desktop");
  }
  const cwd = env.RAKAZO_PI_CWD?.trim();
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error("RAKAZO_PI_CWD must be an absolute trusted server path");
  }
  return {
    command: env.RAKAZO_PI_COMMAND?.trim() || "pi",
    cwd: path.resolve(cwd),
    sessionDir: path.resolve(dataDir, "pi-sessions"),
  };
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  if (env.AGENT_RUNTIME === "pi-local") {
    return { ...LOCAL_PI_DEPLOYMENT_MODEL, key: undefined };
  }
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // A row per provider that ships a deployment key. A third one adds a row here, not a
  // branch at each call site — and an unknown provider gets no key rather than another
  // vendor's, which a ternary on one provider would not give.
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
  };
  const models: Record<string, string> = {
    openrouter: "deepseek/deepseek-v4-flash-0731",
    anthropic: "claude-sonnet-5",
  };
  return {
    provider,
    model: env.PI_DEFAULT_MODEL?.trim() || models[provider] || models.openrouter!,
    key: keys[provider],
  };
}
