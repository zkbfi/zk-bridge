import { describe, expect, it } from "vitest";
import { createDecisionBoard, decisionBoardOf, type WatchDecision } from "../src/watch/decisions.ts";

const decision = (why: string): WatchDecision => ({ at: 1, finalizedSlot: 2, headSlot: 1, genesisTime: 0, secondsPerSlot: 12, due: false, why, detail: why });

describe("the decision board", () => {
  it("keeps the latest decision per direction", () => {
    const board = createDecisionBoard();
    expect(board.latest("first-to-second")).toBeNull();
    board.record("first-to-second", decision("a"));
    board.record("first-to-second", decision("b"));
    expect(board.latest("first-to-second")?.why).toBe("b");
    expect(board.latest("second-to-first")).toBeNull();
  });

  it("gives one board per context", () => {
    const context = {};
    expect(decisionBoardOf(context)).toBe(decisionBoardOf(context));
    expect(decisionBoardOf({})).not.toBe(decisionBoardOf(context));
  });
});
