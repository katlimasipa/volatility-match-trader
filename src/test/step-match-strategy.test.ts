import { describe, expect, it } from "vitest";
import {
  backtestStepMatch,
  getStepMatchTarget,
  type StepMatchConfig,
} from "@/lib/step-match-strategy";

describe("StepMatch strategy", () => {
  it("applies independent above/below rules to each digit band", () => {
    const config: StepMatchConfig = {
      zeroToFour: "above",
      fiveToNine: "below",
    };

    expect(Array.from({ length: 10 }, (_, digit) => getStepMatchTarget(digit, config))).toEqual([
      1, 2, 3, 4, 5, 4, 5, 6, 7, 8,
    ]);
  });

  it("wraps above 9 to 0 and below 0 to 9", () => {
    expect(getStepMatchTarget(9, { zeroToFour: "above", fiveToNine: "above" })).toBe(0);
    expect(getStepMatchTarget(0, { zeroToFour: "below", fiveToNine: "below" })).toBe(9);
  });

  it("returns no target for a value outside the last-digit range", () => {
    const config = { zeroToFour: "above", fiveToNine: "below" } as const;
    expect(getStepMatchTarget(-1, config)).toBeNull();
    expect(getStepMatchTarget(10, config)).toBeNull();
  });

  it("scores each target against only the chronologically following tick", () => {
    const replay = backtestStepMatch([1, 2, 6, 5, 9, 0, 0], {
      zeroToFour: "above",
      fiveToNine: "below",
    });

    expect(replay).toEqual({
      totalTicks: 7,
      signals: 6,
      correct: 2,
      incorrect: 4,
      accuracy: (2 / 6) * 100,
      baselineAccuracy: 10,
    });
  });
});
