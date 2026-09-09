export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
export const MAX_UPSTREAM_TIMEOUT_MS = 600_000;

export function validateUpstreamTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_UPSTREAM_TIMEOUT_MS) {
    throw new Error(`upstream timeout must be an integer from 1 through ${MAX_UPSTREAM_TIMEOUT_MS} milliseconds`);
  }
  return value;
}
