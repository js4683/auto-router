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
