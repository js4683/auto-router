import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouterConfig } from "./types.js";

const DEFAULT_CONFIG_PATHS = [
  "./auto-router.json",
  "../auto-router.json",
  "../../auto-router.json",
];

const DEFAULT_CONFIG: RouterConfig = {
  tiers: {
    simple: { minQuality: 0 },
    medium: { minQuality: 60 },
    complex: { minQuality: 80 },
  },
  scorer: {
    weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
    thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
  },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: {
    code_review: { prefer: null },
    run_tests: { prefer: null, strategy: "lowest-cost" },
    monitoring: { prefer: null },
    planning: { prefer: null, strategy: "quality", minQuality: 85 },
    implement: { prefer: null },
    debug: { prefer: null },
  },
  providerFreeSet: [],
  windowRegistry: { "gpt-5.2": 272000, "gpt-5.2-codex": 272000 },
  catalog: {
    cachePath: "./.cache/auto-router-catalog.json",
    refreshIntervalHours: 24,
    artificialAnalysis: { apiUrl: "https://artificialanalysis.ai/api/v2/data/llms/models", apiKeyEnv: "AA_API_KEY" },
  },
  avengersPro: { enabled: false, artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture", timeoutMs: 400, maxInputChars: 16000 },
  modelMap: {},
};

function asConfig(raw: unknown): RouterConfig {
  return deepMerge(DEFAULT_CONFIG, (raw ?? {}) as Partial<RouterConfig>);
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function stripJsonCommentsSafe(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      // single-line comment — skip to end of line
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readJsonSafe(path: string): any {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    // try with safe comment stripping (for jsonc)
    return JSON.parse(stripJsonCommentsSafe(raw));
  }
}

export function loadConfig(configPath?: string): RouterConfig {
  // Allow env override or explicit path
  const tryPaths: string[] = [];
  if (configPath) tryPaths.push(resolve(configPath));
  if (process.env.AUTO_ROUTER_CONFIG) tryPaths.push(resolve(process.env.AUTO_ROUTER_CONFIG));
  // also check opencode.json for auto-router.path pointer
  try {
    const opencodePath = resolve("./opencode.json");
    if (existsSync(opencodePath)) {
      const oc = readJsonSafe(opencodePath);
      const p = oc?.["auto-router"]?.path ?? oc?.["autoRouter"]?.path;
      if (p) tryPaths.push(resolve(p));
    }
    const opencodeJsonc = resolve("./opencode.jsonc");
    if (existsSync(opencodeJsonc)) {
      const oc = readJsonSafe(opencodeJsonc);
      const p = oc?.["auto-router"]?.path ?? oc?.["autoRouter"]?.path;
      if (p) tryPaths.push(resolve(p));
    }
  } catch {}

  // repo-local .opencode/opencode.json also?
  for (const p of ["./.opencode/opencode.json", "./.opencode/opencode.jsonc"]) {
    if (existsSync(p)) {
      try {
        const oc = readJsonSafe(p);
        const ptr = oc?.["auto-router"]?.path ?? oc?.["autoRouter"]?.path;
        if (ptr) tryPaths.push(resolve(ptr));
      } catch {}
    }
  }

  tryPaths.push(...DEFAULT_CONFIG_PATHS.map((p) => resolve(p)));

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const globalFilePaths = home
    ? [resolve(home, ".config/opencode/auto-router.json"), resolve(home, ".config/opencode/plugins/router-core/auto-router.json")]
    : [];
  const globalInlineCandidates = home
    ? [`${home}/.config/opencode/opencode.json`, `${home}/.config/opencode/opencode.jsonc`].filter(Boolean)
    : [];
  const projectInlineCandidates = ["./opencode.json", "./opencode.jsonc", "./.opencode/opencode.json", "./.opencode/opencode.jsonc"].filter(Boolean);

  // Priority: env/explicit + path pointers + project files > project inline > global inline > global files > fallback
  // 1. Check project inline (highest among inline)
  for (const p of projectInlineCandidates) {
    if (existsSync(p)) {
      try {
        const oc = readJsonSafe(p);
        const inline = oc?.["auto-router"] ?? oc?.["autoRouter"];
        if (inline && inline.tiers) return asConfig(inline);
      } catch {}
    }
  }

  // 2. Check project files (tryPaths contains project files only at this point; global files not yet added)
  for (const p of tryPaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        // If file is opencode.json wrapping auto-router block, unwrap
        if (parsed?.["auto-router"] && !parsed?.tiers) {
          return asConfig(parsed["auto-router"]);
        }
        if (parsed?.tiers) return asConfig(parsed);
      } catch (e) {
        console.warn(`[auto-router] failed to load config at ${p}:`, e);
      }
    }
  }

  // 3. Check global inline (global opencode.json auto-router block)
  for (const p of globalInlineCandidates) {
    if (existsSync(p)) {
      try {
        const oc = readJsonSafe(p);
        const inline = oc?.["auto-router"] ?? oc?.["autoRouter"];
        if (inline && inline.tiers) return asConfig(inline);
      } catch {}
    }
  }

  // 4. Check global files
  for (const p of globalFilePaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.["auto-router"] && !parsed?.tiers) return asConfig(parsed["auto-router"]);
        if (parsed?.tiers) return asConfig(parsed);
      } catch (e) {
        console.warn(`[auto-router] failed to load config at ${p}:`, e);
      }
    }
  }

  return DEFAULT_CONFIG;
}
