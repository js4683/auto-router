export const MANAGED_BEGIN = "# auto-router managed begin";
export const MANAGED_END = "# auto-router managed end";

export function applyManagedBlock(existing: string, block: string): string {
  const stripped = removeManagedBlock(existing);
  const prefix = stripped.endsWith("\n") || stripped === "" ? stripped : `${stripped}\n`;
  return `${prefix}${MANAGED_BEGIN}\n${block.trimEnd()}\n${MANAGED_END}\n`;
}

export function removeManagedBlock(existing: string): string {
  const start = existing.indexOf(MANAGED_BEGIN);
  if (start < 0) return existing;
  const end = existing.indexOf(MANAGED_END, start);
  if (end < 0) return existing;
  const after = existing.slice(end + MANAGED_END.length).replace(/^\n/, "");
  return existing.slice(0, start) + after;
}

function tomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hasAutoRouterProviderTable(existing: string): boolean {
  return /^[ \t]*\[model_providers\.auto-router\][^\r\n]*(?:\r?\n|$)/m.test(existing);
}

function firstTableIndex(existing: string): number {
  const match = /^[ \t]*\[[^\]\r\n]+\][^\r\n]*(?:\r?\n|$)/m.exec(existing);
  return match?.index ?? existing.length;
}

function rootPrefix(existing: string): { prefix: string; suffix: string } {
  const index = firstTableIndex(existing);
  return { prefix: existing.slice(0, index), suffix: existing.slice(index) };
}

function removeOwnedRootProvider(existing: string): string {
  const { prefix, suffix } = rootPrefix(existing);
  return `${prefix.replace(/^[ \t]*model_provider\s*=\s*"auto-router"\s*(?:\r?\n|$)/m, "")}${suffix}`;
}

function setRootProvider(prefix: string): string {
  const line = 'model_provider = "auto-router"';
  if (/^[ \t]*model_provider\s*=\s*[^\r\n]*(?:\r?\n|$)/m.test(prefix)) {
    return prefix.replace(/^[ \t]*model_provider\s*=\s*[^\r\n]*(?:\r?\n|$)/m, `${line}\n`);
  }
  const normalized = prefix && !prefix.endsWith("\n") ? `${prefix}\n` : prefix;
  return `${normalized}${line}\n`;
}

function codexBlock(baseUrl: string): string {
  const base = tomlString(`${baseUrl}/v1`);
  return `${MANAGED_BEGIN}\n[model_providers.auto-router]\nname = "auto-router"\nbase_url = "${base}"\nwire_api = "responses"\n${MANAGED_END}\n`;
}

export function upsertCodexProvider(existing: string, baseUrl: string): string {
  const withoutManaged = removeManagedBlock(existing);
  if (hasAutoRouterProviderTable(withoutManaged)) throw new Error("refusing to overwrite user-owned [model_providers.auto-router] table");
  const { prefix, suffix } = rootPrefix(withoutManaged);
  const root = setRootProvider(prefix);
  const separator = suffix && root && !root.endsWith("\n") ? "\n" : "";
  return `${root}${separator}${codexBlock(baseUrl)}${suffix}`;
}

export function removeCodexProvider(existing: string, state: { ownedKeys: string[]; ownedValues?: Record<string, string> }, baseUrl: string): string {
  const expectedBase = state.ownedValues?.baseUrl ?? `${baseUrl}/v1`;
  const managedStart = existing.indexOf(MANAGED_BEGIN);
  if (managedStart >= 0) {
    const managedEnd = existing.indexOf(MANAGED_END, managedStart);
    if (managedEnd < 0) return existing;
    const managed = existing.slice(managedStart + MANAGED_BEGIN.length, managedEnd).replace(/^\r?\n/, "").replace(/\r\n/g, "\n").trim();
    const expected = `[model_providers.auto-router]\nname = "auto-router"\nbase_url = "${tomlString(expectedBase)}"\nwire_api = "responses"`;
    return managed === expected ? removeOwnedRootProvider(removeManagedBlock(existing)) : existing;
  }
  if (hasAutoRouterProviderTable(existing)) return existing;
  let next = existing;
  const { prefix, suffix } = rootPrefix(next);
  next = removeOwnedRootProvider(`${prefix}${suffix}`);
  return next;
}
