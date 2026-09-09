import type { ModelCatalogEntry, ModelRuntimeSnapshot, ModelSelection } from "@rakazo/contracts";

export type PiModelSnapshot = ModelRuntimeSnapshot;
export function modelIdentity(selection: ModelSelection | null | undefined): string {
  return selection
    ? `${selection.provider}/${selection.modelId}${selection.thinkingLevel ? ` · ${selection.thinkingLevel}` : ""}`
    : "";
}
export { modelOptionKey as modelKey } from "@rakazo/core";
export function searchPiModels(catalog: ModelCatalogEntry[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/);
  return catalog.filter((entry) =>
    terms.every((term) =>
      `${entry.provider} ${entry.id} ${entry.label} ${entry.providerName ?? ""}`
        .toLowerCase()
        .includes(term),
    ),
  );
}
export function retainPiInventory(
  previous: PiModelSnapshot | null,
  next: PiModelSnapshot,
): PiModelSnapshot {
  return next.availability.status === "unavailable" && previous
    ? { ...next, catalog: previous.catalog, profileDefault: previous.profileDefault }
    : next;
}
