import { describe, expect, it } from "vitest";
import {
  analyze,
  lastDigit,
  shouldEnter,
  MAX_DIFF,
  SYMBOL,
  CLASSIC_SYMBOL,
  OPTIONS_SYMBOL,
  MARKETS,
  MARKET_LIST,
  getMarketConfig,
  marketTradeSymbols,
  calculateMartingaleStake,
} from "@/lib/matches";

const build = (counts: number[]) => counts.flatMap((c, d) => new Array(c).fill(d));

describe("Volatility 100 Matches strategy", () => {
  it("targets Volatility 100 with classic and Auth 2.0 symbols", () => {
    expect(CLASSIC_SYMBOL).toBe("R_100");
    expect(OPTIONS_SYMBOL).toBe("R_100");
    expect(SYMBOL).toBe("R_100");
    expect(lastDigit(1234.5)).toBe(0);
    expect(lastDigit(1234.57)).toBe(7);
    expect(lastDigit(9876.10)).toBe(0);
    expect(lastDigit(9876.19)).toBe(9);
  });

  it("supports Volatility 10 Index with 3 pip decimals and correct symbols", () => {
    const v10 = MARKETS.R_10;
    expect(v10.id).toBe("R_10");
    expect(v10.displayName).toBe("Volatility 10 Index");
    expect(v10.classicSymbol).toBe("R_10");
    expect(v10.optionsSymbol).toBe("R_10");
    expect(v10.pipDecimals).toBe(3);

    expect(lastDigit(6543.218, v10.pipDecimals)).toBe(8);
    expect(lastDigit(6543.210, v10.pipDecimals)).toBe(0);
    expect(lastDigit(6543.219, v10.pipDecimals)).toBe(9);
    expect(lastDigit(6543.21, v10.pipDecimals)).toBe(0);

    expect(getMarketConfig("R_10").classicSymbol).toBe("R_10");
    expect(getMarketConfig("1HZ10V").classicSymbol).toBe("1HZ10V");
    expect(getMarketConfig("R_100").classicSymbol).toBe("R_100");
    expect(getMarketConfig().classicSymbol).toBe("R_100");
    expect(MARKET_LIST.map((m) => m.id)).toEqual(["R_100", "R_10", "1HZ100V", "1HZ10V"]);

    expect(marketTradeSymbols(v10, "classic")).toEqual({
      preferred: "R_10",
      fallback: "R_10",
    });
    expect(marketTradeSymbols(v10, "otp")).toEqual({
      preferred: "R_10",
      fallback: "R_10",
    });
  });

  it("keeps 1-second indices separate from standard indices", () => {
    const v100s = getMarketConfig("1HZ100V");
    const v10s = getMarketConfig("1HZ10V");
    expect(v100s.displayName).toBe("Volatility 100 (1s) Index");
    expect(v100s.classicSymbol).toBe("1HZ100V");
    expect(v100s.optionsSymbol).toBe("1HZ100V");
    expect(v10s.displayName).toBe("Volatility 10 (1s) Index");
    expect(v10s.classicSymbol).toBe("1HZ10V");
    expect(v10s.optionsSymbol).toBe("1HZ10V");
    expect(marketTradeSymbols(v10s, "otp")).toEqual({
      preferred: "1HZ10V",
      fallback: "1HZ10V",
    });
  });

  it("applies 1.5× martingale progression only when enabled", () => {
    expect(calculateMartingaleStake(1, 0, true)).toBe(1);
    expect(calculateMartingaleStake(1, 1, true)).toBe(1.5);
    expect(calculateMartingaleStake(1, 2, true)).toBe(2.25);
    expect(calculateMartingaleStake(1, 3, false)).toBe(1);
    expect(calculateMartingaleStake(0.35, 1, true)).toBe(0.53);
  });

  it("identifies most and second most appearing digits", () => {
    // 1000 ticks: digit 4 has 150, digit 2 has 148, rest distributed
    const counts = [80, 80, 148, 80, 150, 80, 80, 80, 80, 142];
    const a = analyze(build(counts));
    expect(a.most).toBe(4);
    expect(a.second).toBe(2);
    expect(a.mostPct).toBe(15.0);
    expect(a.secondPct).toBe(14.8);
    expect(a.diff).toBe(0.2);
    expect(a.ok).toBe(true);
  });

  it("allows trade when difference is <= 0.3 (default MAX_DIFF)", () => {
    // Exactly 1000 ticks: 120/1000 = 12.0%, 117/1000 = 11.7% -> diff exactly 0.3
    const counts = [95, 95, 95, 120, 95, 95, 95, 117, 94, 99];
    const a = analyze(build(counts));
    expect(a.most).toBe(3);
    expect(a.diff).toBe(0.3);
    expect(a.ok).toBe(true);
  });

  it("blocks trade when difference exceeds 0.3 (default MAX_DIFF)", () => {
    // Exactly 1000 ticks: 120/1000 = 12.0%, 116/1000 = 11.6% -> diff 0.4 > 0.3
    const counts = [98, 98, 98, 120, 98, 98, 98, 116, 88, 88];
    const a = analyze(build(counts));
    expect(a.most).toBe(3);
    expect(a.diff).toBe(0.4);
    expect(a.ok).toBe(false);
  });

  it("supports configurable spread threshold", () => {
    const counts = [95, 95, 95, 125, 95, 95, 95, 115, 90, 100]; // 1000 ticks, diff 1.0%
    const strictAnalysis = analyze(build(counts), 0.3);
    expect(strictAnalysis.diff).toBe(1.0);
    expect(strictAnalysis.ok).toBe(false);

    const relaxedAnalysis = analyze(build(counts), 1.5);
    expect(relaxedAnalysis.diff).toBe(1.0);
    expect(relaxedAnalysis.ok).toBe(true);
  });

  it("uses the most appearing digit as entry trigger", () => {
    const counts = [98, 98, 98, 120, 98, 98, 98, 118, 87, 87];
    const a = analyze(build(counts));
    expect(a.most).toBe(3);
    expect(a.second).toBe(7);

    // Current digit must match the most appearing digit (3)
    expect(shouldEnter(a, 3)).toBe(true);
    expect(shouldEnter(a, 7)).toBe(false);
    expect(shouldEnter(a, 0)).toBe(false);
  });

  it("strictly requires 1000 ticks before allowing trade entry", () => {
    // Only 500 ticks buffered
    const counts = [50, 50, 60, 50, 50, 50, 50, 59, 40, 41];
    const a = analyze(build(counts));
    expect(a.total).toBe(500);
    expect(a.ready).toBe(false);
    expect(a.ok).toBe(false);
    // Even if diff <= 0.3% and incoming digit matches D1, shouldEnter must be false
    expect(shouldEnter(a, a.most)).toBe(false);
  });

});
