import { describe, expect, it } from "vitest";
import { replayDataset } from "../src/replay.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

describe("replayDataset", () => {
  it("preserves router state and reselects at a planning boundary", () => {
    const first = fixtureTurn();
    const followUp = fixtureTurn({
      id: "turn-2",
      sessionState: {
        ...first.sessionState,
        isNewSession: false,
        currentTask: { ...first.sessionState.currentTask, lastUserMessage: "Continue the same implementation" },
      },
    });
    const planning = fixtureTurn({
      id: "turn-3",
      sessionState: {
        ...first.sessionState,
        isNewSession: false,
        isCompacted: true,
        userTag: "planning",
        currentTask: { ...first.sessionState.currentTask, lastUserMessage: "Plan the architecture" },
      },
    });
    const result = replayDataset(fixtureDataset([first, followUp, planning]));

    expect(result.strategies.router.turns.map((turn) => turn.modelId)).toEqual([
      "provider/cheap",
      "provider/cheap",
      "provider/frontier",
    ]);
    expect(result.strategies.router.turns[1].via).toBe("stay-sticky");
    expect(result.strategies["always-frontier"].turns.every((turn) => turn.modelId === "provider/frontier")).toBe(true);
    expect(result.strategies["always-cheap"].turns.every((turn) => turn.modelId === "provider/cheap")).toBe(true);
  });

  it("applies hard capability eligibility to sticky router selections", () => {
    const first = fixtureTurn();
    const constrainedFollowUp = fixtureTurn({
      id: "turn-2",
      requiredCapabilities: ["tools"],
      sessionState: {
        ...first.sessionState,
        isNewSession: false,
        currentTask: { ...first.sessionState.currentTask, lastUserMessage: "Continue with the required tool" },
      },
    });
    const dataset = fixtureDataset([first, constrainedFollowUp]);
    dataset.capabilities = { "provider/cheap": [], "provider/frontier": ["tools"] };

    const result = replayDataset(dataset);

    expect(result.strategies.router.turns.map((turn) => turn.modelId)).toEqual(["provider/cheap", "provider/frontier"]);
  });
});
