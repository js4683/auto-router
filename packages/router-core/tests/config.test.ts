import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig merge", () => {
  it("fills missing planning and verification policies from defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-config-"));
    const path = join(dir, "stale.json");
    writeFileSync(
      path,
      JSON.stringify({
        tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
        taskTypeModels: {
          code_review: { prefer: null },
          run_tests: { prefer: null },
          monitoring: { prefer: null },
          implement: { prefer: null },
          debug: { prefer: null },
        },
      })
    );

    const cfg = loadConfig(path);

    expect(cfg.taskTypeModels.planning).toEqual({ prefer: null, strategy: "quality", minQuality: 85 });
    expect(cfg.taskTypeModels.run_tests.strategy).toBe("lowest-cost");
  });
});
