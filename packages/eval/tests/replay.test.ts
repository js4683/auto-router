import { describe, expect, it } from "vitest";
import { replayDataset, selectReplayRouterStep } from "../src/replay.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

describe("selectReplayRouterStep", () => {
  it("returns the same first-turn selection as replayDataset", () => {
    const dataset = fixtureDataset();
    const turn = dataset.sessions[0].turns[0];
    const step = selectReplayRouterStep(dataset, turn, { currentModel: null, currentTier: null, downgradeCounter: 0 });
    const replay = replayDataset(dataset);
    expect(step.selection.modelId).toBe(replay.strategies.router.turns[0].modelId);
  });
});

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
    dataset.capabilities = { "provider/cheap": ["text"], "provider/frontier": ["text", "tools"] };

    const result = replayDataset(dataset);

    expect(result.strategies.router.turns.map((turn) => turn.modelId)).toEqual(["provider/cheap", "provider/frontier"]);
    expect(result.strategies.router.turns[0]).toMatchObject({ weight: 1, terminalState: "completed", contentTruncated: false });
  });

  it("lets the context-fit guard own a downgrade when the cheap model no longer fits", () => {
    const dataset = fixtureDataset();
    dataset.config.stickiness.downgradeAfter = 1;
    dataset.catalog.models.push({
      id: "alternate",
      runtimeId: "provider/alternate",
      codingIndex: 65,
      blendedPrice: 5,
      value: 13,
      windowTokens: 256000,
      isFree: false,
    });
    dataset.capabilities!["provider/alternate"] = ["text", "tools"];
    const first = fixtureTurn({
      id: "turn-1",
      sessionState: { ...fixtureTurn().sessionState, forceTier: "complex" },
    });
    const downgrade = fixtureTurn({
      id: "turn-2",
      sessionState: {
        ...first.sessionState,
        lifetimeTokens: 200000,
        isNewSession: false,
        isCompacted: true,
        forceTier: "simple",
      },
    });

    const result = replayDataset({ ...dataset, sessions: [{ id: "session-1", turns: [first, downgrade] }] });

    expect(result.strategies.router.turns[1]).toMatchObject({ modelId: "provider/frontier", via: "context-fit-block" });
  });

  it("excludes context-ineligible models from an initial selection", () => {
    const turn = fixtureTurn({
      sessionState: { ...fixtureTurn().sessionState, lifetimeTokens: 200000 },
    });

    const result = replayDataset(fixtureDataset([turn]));

    expect(result.strategies.router.turns[0].modelId).toBe("provider/frontier");
  });

  it("reselects when the current model no longer fits on a same-tier boundary", () => {
    const first = fixtureTurn({ id: "turn-1" });
    const second = fixtureTurn({
      id: "turn-2",
      sessionState: {
        ...first.sessionState,
        lifetimeTokens: 200000,
        isNewSession: false,
        isCompacted: true,
      },
    });

    const result = replayDataset(fixtureDataset([first, second]));

    expect(result.strategies.router.turns[1].modelId).toBe("provider/frontier");
  });

  it("exposes incomplete recorded turns to every strategy", () => {
    const result = replayDataset(fixtureDataset([fixtureTurn({ terminalState: "incomplete", contentTruncated: true, weight: 2 })]));

    expect(result.strategies.router.turns[0]).toMatchObject({ terminalState: "incomplete", contentTruncated: true, weight: 2 });
    expect(result.strategies.router.incompleteReasons).toEqual(
      expect.arrayContaining([
        "recorded turn session-1/turn-1 has terminal state incomplete",
        "recorded turn session-1/turn-1 has truncated content",
      ])
    );
    expect(result.strategies["always-frontier"].incompleteReasons).toEqual(expect.arrayContaining(result.strategies.router.incompleteReasons));
  });
});
