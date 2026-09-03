import { describe, expect, it } from "vitest";
import { eligibleModels, selectCheap, selectFrontier } from "../src/strategies.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

describe("baseline strategies", () => {
  it("selects highest quality for frontier and lowest cost for cheap", () => {
    const dataset = fixtureDataset();
    const turn = fixtureTurn({ requiredCapabilities: ["tools"] });

    expect(selectFrontier(dataset, turn).runtimeId).toBe("provider/frontier");
    expect(selectCheap(dataset, turn).runtimeId).toBe("provider/cheap");
  });

  it("uses deterministic tie-breaks without mutating catalog order", () => {
    const dataset = fixtureDataset();
    dataset.catalog.models.push({
      ...dataset.catalog.models[0],
      id: "alpha",
      runtimeId: "provider/alpha",
    });
    dataset.capabilities!["provider/alpha"] = ["text", "tools"];
    const originalOrder = dataset.catalog.models.map((model) => model.id);

    expect(selectCheap(dataset, fixtureTurn()).runtimeId).toBe("provider/alpha");
    expect(dataset.catalog.models.map((model) => model.id)).toEqual(originalOrder);
  });

  it("filters by context and required capabilities", () => {
    const dataset = fixtureDataset();
    dataset.capabilities!["provider/cheap"] = [];
    const turn = fixtureTurn({
      requiredCapabilities: ["tools"],
      sessionState: { ...fixtureTurn().sessionState, lifetimeTokens: 130000 },
    });

    expect(eligibleModels(dataset, turn).map((model) => model.runtimeId)).toEqual(["provider/frontier"]);
  });

  it("fails when no model is eligible", () => {
    const turn = fixtureTurn({ sessionState: { ...fixtureTurn().sessionState, lifetimeTokens: 300000 } });
    expect(() => selectCheap(fixtureDataset(), turn)).toThrow("no eligible model for turn turn-1");
  });
});
