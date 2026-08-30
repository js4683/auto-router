#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { fetchAACatalog } from "./catalog.js";

const config = loadConfig();
const catalog = await fetchAACatalog(config);
console.log(`[auto-router] catalog ${catalog.source} ${catalog.models.length} models @ ${catalog.fetchedAt}`);
for (const m of catalog.models.slice(0, 10)) {
  console.log(`  ${m.id} coding=${m.codingIndex} value=${m.value.toFixed(3)} free=${m.isFree} window=${m.windowTokens}`);
}
