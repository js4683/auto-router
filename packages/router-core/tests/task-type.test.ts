import { describe, it, expect } from "vitest";
import { resolveTaskType } from "../src/task-type.js";
import type { RouterConfig, SessionState } from "../src/types.js";

const cfgBase: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: { weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: { code_review: { prefer: null }, run_tests: { prefer: null }, monitoring: { prefer: null }, planning: { prefer: null }, implement: { prefer: null }, debug: { prefer: null } },
  providerFreeSet: [],
  windowRegistry: {},
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
  agentTaskTypeMap: { review: "code_review", tester: "run_tests" },
};

function sess(msg: string, extra: Partial<SessionState> & Partial<SessionState["currentTask"]> = {}): SessionState {
  return {
    lifetimeTokens: 1000,
    currentTask: {
      promptTokens: 100,
      taskTokens: 1000,
      filesTouched: extra.filesTouched ?? 0,
      diffHunks: extra.diffHunks ?? 0,
      toolDepth: extra.toolDepth ?? 0,
      lastUserMessage: msg,
    },
    userTag: (extra as any).userTag,
    activeAgent: (extra as any).activeAgent,
  };
}

describe("resolveTaskType", () => {
  it("explicit userTag wins with confidence 1", () => {
    const r = resolveTaskType(sess("hello", { userTag: "code_review" }), cfgBase);
    expect(r.type).toBe("code_review");
    expect(r.confidence).toBe(1);
    expect(r.via).toBe("userTag");
  });

  it("agent map wins", () => {
    const r = resolveTaskType(sess("hello", { activeAgent: "review" }), cfgBase);
    expect(r.type).toBe("code_review");
  });

  it("resolves an explicit planning tag", () => {
    const r = resolveTaskType(sess("compare options", { userTag: "planning" }), cfgBase);
    expect(r.type).toBe("planning");
    expect(r.confidence).toBe(1);
  });

  it("recognizes no-mistakes as verification without corroboration", () => {
    const r = resolveTaskType(sess("run no-mistakes and report failures"), cfgBase);
    expect(r.type).toBe("run_tests");
  });

  it("recognizes lint and typecheck as verification without corroboration", () => {
    const r = resolveTaskType(sess("run lint and typecheck"), cfgBase);
    expect(r.type).toBe("run_tests");
  });

  it("recognizes architecture planning without corroboration", () => {
    const r = resolveTaskType(sess("plan the architecture for this project"), cfgBase);
    expect(r.type).toBe("planning");
  });

  it("gated auto-detect: pattern without corroboration -> weak (null)", () => {
    const r = resolveTaskType(sess("please review this pr"), cfgBase);
    expect(r.type).toBeNull();
    expect(r.via).toMatch(/auto-weak/);
  });

  it("gated auto-detect: pattern with corroboration (files>=2) -> type", () => {
    const r = resolveTaskType(sess("please review this pr", { filesTouched: 3, toolDepth: 2 }), cfgBase);
    expect(r.type).toBe("code_review");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("monitoring auto with corroboration", () => {
    const r = resolveTaskType(sess("check monitoring alert dashboard slo", { toolDepth: 3 }), cfgBase);
    expect(r.type).toBe("monitoring");
  });

  it("fallback to null when no signal", () => {
    const r = resolveTaskType(sess("hello world generic"), cfgBase);
    expect(r.type).toBeNull();
  });
});
