import type { Catalog, ModelEntry, RouterConfig } from "./types.js";

/**
 * Context-fit guard (grill Q2): refuse downgrade if session won't fit target window + margin.
 * Fail-open: if window unknown, treat as fit (don't block).
 */
export function passesContextFit(
  lifetimeTokens: number,
  target: ModelEntry,
  config: RouterConfig
): { pass: boolean; reason: string } {
  const margin = config.guards.contextFitMarginTokens ?? 8000;
  const window = target.windowTokens;

  if (!window || window <= 0) {
    return { pass: true, reason: `unknown window for ${target.id} — fail-open` };
  }

  const needed = lifetimeTokens + margin;
  if (needed <= window) return { pass: true, reason: `fits ${needed} <= ${window}` };
  return { pass: false, reason: `would overflow: ${needed} > ${window} (lifetime ${lifetimeTokens} + margin ${margin})` };
}

/**
 * Find catalog entry by id.
 */
export function findModel(catalog: Catalog, id: string): ModelEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

/**
 * Tier upgrade check — compare tier ranks.
 */
export function isUpgrade(fromTier: string | null, toTier: string): boolean {
  if (!fromTier) return true;
  const rank = (t: string) => (t === "simple" ? 0 : t === "medium" ? 1 : 2);
  return rank(toTier) > rank(fromTier);
}
