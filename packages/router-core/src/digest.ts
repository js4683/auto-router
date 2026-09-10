import { createHash } from "node:crypto";
import type { RouterConfig } from "./types.js";

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains an unsupported value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("canonical JSON contains an unsupported value");
  if (ancestors.has(value)) throw new Error("canonical JSON contains a cyclic value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, ancestors)).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalValue(value, new Set<object>())).digest("hex");
}

export function policyDigest(config: RouterConfig): string {
  return canonicalDigest(config);
}
