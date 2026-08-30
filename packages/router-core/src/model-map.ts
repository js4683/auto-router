import type { Catalog, ModelMap, ModelMapSource } from "./types.js";

export function resolveMappedModels(
  paperIds: string[],
  modelMap: ModelMap,
  catalog: Catalog
): { runtimeId: string; paperId: string; source: ModelMapSource }[] {
  const resolved: { runtimeId: string; paperId: string; source: ModelMapSource }[] = [];
  const seen = new Set<string>();

  for (const paperId of paperIds) {
    const entries = [...(modelMap[paperId] ?? [])].sort((a, b) => Number(b.source === "bench") - Number(a.source === "bench"));
    for (const entry of entries) {
      const match = catalog.models.find((m) => m.runtimeId === entry.runtimeId || m.id === entry.runtimeId);
      if (!match || seen.has(entry.runtimeId)) continue;
      seen.add(entry.runtimeId);
      resolved.push({ runtimeId: entry.runtimeId, paperId, source: entry.source });
    }
  }

  return resolved;
}
