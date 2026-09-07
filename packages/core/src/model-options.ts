import type { ModelCatalogEntry, ModelCredential, ThinkingLevel } from "@rakazo/contracts";

export function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}
export function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}
export function connectedModelOptions(
  credentials: readonly ModelCredential[],
  catalog: readonly ModelCatalogEntry[],
) {
  const result = new Map<
    string,
    {
      key: string;
      provider: string;
      modelId: string;
      label: string;
      thinkingLevels: ThinkingLevel[];
    }
  >();
  for (const credential of credentials) {
    const entries = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const custom = credential.modelId && !entries.some((entry) => entry.id === credential.modelId);
    const options = custom
      ? [
          {
            provider: credential.provider,
            modelId: credential.modelId!,
            label: `${credential.label} · ${credential.modelId}`,
            thinkingLevels: credential.thinkingLevels ?? [],
          },
        ]
      : entries.map((entry) => ({
          provider: entry.provider,
          modelId: entry.id,
          label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
          thinkingLevels:
            (credential.modelId === entry.id ? credential.thinkingLevels : undefined) ??
            entry.thinkingLevels ??
            [],
        }));
    for (const option of options) {
      const key = modelOptionKey(option.provider, option.modelId);
      if (!result.has(key)) result.set(key, { key, ...option });
    }
  }
  return [...result.values()];
}
