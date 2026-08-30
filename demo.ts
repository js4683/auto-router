#!/usr/bin/env tsx
// Local demo: run `npx tsx demo.ts` from auto-router root after `npm run build`
import { selectModel, loadConfig, loadCatalogSync } from "./packages/router-core/src/index.js";
import type { SessionState, RouterState, Catalog } from "./packages/router-core/src/index.js";

const config = loadConfig("./auto-router.json");
const catalog = loadCatalogSync(config);
console.log(`[demo] catalog source=${catalog.source} models=${catalog.models.length}`);
catalog.models.slice(0,3).forEach(m => console.log(`  ${m.id} q=${m.codingIndex} v=${m.value.toFixed(2)} free=${m.isFree} win=${m.windowTokens}`));

let state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
let prevAgent: string | undefined;
let prevMsg: string | undefined;

function step(label: string, s: SessionState) {
  const r = selectModel(s, catalog, config, state, prevAgent, prevMsg);
  console.log(`\n[${label}] "${s.currentTask.lastUserMessage.slice(0,60)}" -> tier=${r.tier} score=${r.score.toFixed(2)} via=${r.via} model=${r.modelId} reason=${r.reason}`);
  if (r.via !== "stay-sticky" && r.via !== "context-fit-block") {
    state.currentModel = r.modelId;
    state.currentTier = r.tier;
    state.downgradeCounter = 0;
  } else if (r.blockedDowngrade) state.downgradeCounter++;
  prevAgent = s.activeAgent;
  prevMsg = s.currentTask.lastUserMessage;
  return r;
}

step("T1 simple", { lifetimeTokens: 2000, currentTask: { promptTokens: 80, taskTokens: 800, filesTouched: 1, diffHunks: 0, toolDepth: 1, lastUserMessage: "fix typo in README" }, isNewSession: true });
step("T2 still simple no boundary => stick", { lifetimeTokens: 2500, currentTask: { promptTokens: 90, taskTokens: 900, filesTouched: 1, diffHunks: 0, toolDepth: 1, lastUserMessage: "also fix comment formatting" } });
step("T3 medium via gated heuristic (need boundary)", { lifetimeTokens: 5000, currentTask: { promptTokens: 800, taskTokens: 5000, filesTouched: 4, diffHunks: 6, toolDepth: 4, lastUserMessage: "implement feature for user auth with tests" }, isCompacted: true });
step("T4 complex + review taskType prefer", { lifetimeTokens: 8000, currentTask: { promptTokens: 1200, taskTokens: 12000, filesTouched: 8, diffHunks: 12, toolDepth: 6, lastUserMessage: "review this pr for concurrency race [task:code_review]" }, userTag: "code_review", isCompacted: true } as any);
step("T5 hard upgrade signal", { lifetimeTokens: 9000, currentTask: { promptTokens: 300, taskTokens: 9300, filesTouched: 2, diffHunks: 2, toolDepth: 7, lastUserMessage: "why doesn't this work error retry deadlock?", priorErrors: 2 } });
step("T6 downgrade attempt without enough boundaries => stay", { lifetimeTokens: 9500, currentTask: { promptTokens: 70, taskTokens: 500, filesTouched: 1, diffHunks: 0, toolDepth: 1, lastUserMessage: "bump version typo" }, isCompacted: false });
step("T7 context-fit block (large lifetime -> cannot downgrade to small window)", { lifetimeTokens: 200000, currentTask: { promptTokens: 70, taskTokens: 500, filesTouched: 1, diffHunks: 0, toolDepth: 1, lastUserMessage: "typo" }, isCompacted: true, forceTier: "simple" } as any);

console.log("\n[demo] done — router holds context, downgrades gated, upgrades instant, taskType prefer respected");
