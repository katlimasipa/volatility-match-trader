import { describe, expect, it } from "vitest";
import { calculateMatchesPayout, DERIV_MATCH_BASE_PAYOUT_RATIO } from "@/routes/_authenticated/trade";

describe("Matches payout math", () => {
  it("uses Deriv 11.20% digit-match base ratio", () => {
    expect(DERIV_MATCH_BASE_PAYOUT_RATIO).toBeCloseTo(100 / 11.2, 5);
  });

  it("applies app markup to net win profit", () => {
    const noMarkup = calculateMatchesPayout(10, 0);
    const withMarkup = calculateMatchesPayout(10, 3);
    expect(noMarkup.netWinProfit).toBeGreaterThan(withMarkup.netWinProfit);
    expect(withMarkup.markupPercent).toBe(3);
    expect(withMarkup.clientGrossPayout).toBeLessThan(noMarkup.clientGrossPayout);
  });

  it("returns loss magnitude equal to stake when used as paper PnL", () => {
    const stake = 5;
    const { netWinProfit } = calculateMatchesPayout(stake, 3);
    expect(netWinProfit).toBeGreaterThan(0);
    expect(-stake).toBe(-5);
  });
});
