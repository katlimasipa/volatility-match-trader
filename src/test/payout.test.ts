import { afterEach, describe, expect, it } from "vitest";
import {
  getStoredMatchRatio,
  ratioFromContract,
  scalePayoutFromRatio,
  setStoredMatchRatio,
} from "@/lib/payout";

describe("payout ratio math", () => {
  it("calculates one unit of stake using a 6.67 payout ratio", () => {
    expect(scalePayoutFromRatio(1, 6.67)).toEqual({ payout: 6.67, profit: 5.67 });
  });

  it("rounds scaled payouts and profits to cents", () => {
    expect(scalePayoutFromRatio(2.5, 6.67)).toEqual({ payout: 16.68, profit: 14.18 });
  });

  it("derives a payout ratio from a settled contract", () => {
    expect(ratioFromContract(1, 6.67)).toBeCloseTo(6.67);
    expect(ratioFromContract(0, 6.67)).toBeNull();
    expect(ratioFromContract(1, 0)).toBeNull();
  });
});

describe("stored payout ratios", () => {
  afterEach(() => {
    localStorage.removeItem("thdpst_match_ratio_CR12345");
    localStorage.removeItem("thdpst_match_ratio_VRTC12345");
  });

  it("stores ratios separately by account id", () => {
    setStoredMatchRatio("CR12345", 6.67);
    setStoredMatchRatio("VRTC12345", 5.5);

    expect(getStoredMatchRatio("cr12345")).toBe(6.67);
    expect(getStoredMatchRatio("VRTC12345")).toBe(5.5);
    expect(getStoredMatchRatio("CR99999")).toBeNull();
  });
});
