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
import {
  advanceX2XScanner,
  cancelX2XScanner,
  calculateX2XOpTrigger,
  createX2XScannerState,
  lastTwoQuoteDigits,
  rememberUniqueX2XTick,
  runX2XBacktest,
  type X2XQuoteDigit,
} from "@/lib/x2x-strategy";

const build = (counts: number[]) => counts.flatMap((c, d) => new Array(c).fill(d));
const x2xTick = (quote: number, tickId?: string): X2XQuoteDigit => ({
  digit: lastDigit(quote, 2),
  lastTwoQuoteDigits: lastTwoQuoteDigits(quote, 2),
  quote,
  tickId,
  timestamp: "2026-10-23T12:00:00.000Z",
});

describe("Volatility 100 Matches strategy", () => {
  it("targets Volatility 100 with classic and Auth 2.0 symbols", () => {
    expect(CLASSIC_SYMBOL).toBe("R_100");
    expect(OPTIONS_SYMBOL).toBe("R_100");
    expect(SYMBOL).toBe("R_100");
    expect(lastDigit(1234.5)).toBe(0);
    expect(lastDigit(1234.57)).toBe(7);
    expect(lastDigit(9876.1)).toBe(0);
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
    expect(lastDigit(6543.21, v10.pipDecimals)).toBe(0);
    expect(lastDigit(6543.219, v10.pipDecimals)).toBe(9);
    expect(lastDigit(6543.21, v10.pipDecimals)).toBe(0);

    expect(getMarketConfig("R_10").classicSymbol).toBe("R_10");
    expect(getMarketConfig("1HZ10V").classicSymbol).toBe("1HZ10V");
    expect(getMarketConfig("R_100").classicSymbol).toBe("R_100");
    expect(getMarketConfig().classicSymbol).toBe("R_100");
    expect(MARKET_LIST.map((m) => m.id)).toEqual([
      "R_100",
      "R_75",
      "R_10",
      "1HZ100V",
      "1HZ75V",
      "1HZ10V",
    ]);

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
    expect(a.ok).toBe(false);
  });

  it("allows trade when difference exactly matches 0.3 (default MAX_DIFF)", () => {
    // Exactly 1000 ticks: 120/1000 = 12.0%, 117/1000 = 11.7% -> diff exactly 0.3
    const counts = [95, 95, 95, 120, 95, 95, 95, 117, 94, 99];
    const a = analyze(build(counts));
    expect(a.most).toBe(3);
    expect(a.diff).toBe(0.3);
    expect(a.ok).toBe(true);
  });

  it("blocks trade when difference does not exactly match 0.3 (default MAX_DIFF)", () => {
    // Exactly 1000 ticks: 120/1000 = 12.0%, 116/1000 = 11.6% -> diff 0.4 != 0.3
    const counts = [98, 98, 98, 120, 98, 98, 98, 116, 88, 88];
    const a = analyze(build(counts));
    expect(a.most).toBe(3);
    expect(a.diff).toBe(0.4);
    expect(a.ok).toBe(false);
  });

  it("requires the configured spread target to match exactly", () => {
    const counts = [95, 95, 95, 122, 95, 95, 95, 115, 93, 100]; // 1000 ticks, diff 0.7%
    const strictAnalysis = analyze(build(counts), 0.3);
    expect(strictAnalysis.diff).toBe(0.7);
    expect(strictAnalysis.ok).toBe(false);

    const exactAnalysis = analyze(build(counts), 0.7);
    expect(exactAnalysis.diff).toBe(0.7);
    expect(exactAnalysis.ok).toBe(true);

    const differentAnalysis = analyze(build(counts), 1.5);
    expect(differentAnalysis.diff).toBe(0.7);
    expect(differentAnalysis.ok).toBe(false);
  });

  it("uses the most appearing digit as entry trigger", () => {
    const counts = [98, 98, 98, 120, 98, 98, 98, 117, 88, 87];
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

describe("X2X Digit Match Sniper strategy", () => {
  it("detects 525 across three consecutive tick digits and takes the next digit as LDP", () => {
    let state = createX2XScannerState();
    let step = advanceX2XScanner(state, x2xTick(1234.15), true); // digit 5
    state = step.state;
    expect(step.event).toBeNull();

    step = advanceX2XScanner(state, x2xTick(1234.12), true); // digit 2
    state = step.state;
    expect(step.event).toBeNull();

    step = advanceX2XScanner(state, x2xTick(1234.25), true); // digit 5: pattern 525
    state = step.state;
    expect(step.event).toMatchObject({
      type: "pattern",
      pattern: "525",
      referencePair: "25",
      opTrigger: "05",
    });

    step = advanceX2XScanner(state, x2xTick(1234.68), true); // following digit 8 is LDP
    state = step.state;
    expect(step.event).toMatchObject({
      type: "ldp",
      pattern: "525",
      referencePair: "25",
      opTrigger: "05",
      ldp: 8,
    });

    step = advanceX2XScanner(state, x2xTick(1234.05), true);
    expect(step.event).toMatchObject({
      type: "trigger",
      pattern: "525",
      referencePair: "25",
      opTrigger: "05",
      ldp: 8,
    });
  });

  it("matches the supplied 727 / 27 / 05 / 07 tick example", () => {
    let state = createX2XScannerState();
    state = advanceX2XScanner(state, x2xTick(1234.17), true).state; // 7
    state = advanceX2XScanner(state, x2xTick(1234.12), true).state; // 2

    const pattern = advanceX2XScanner(state, x2xTick(1234.27), true); // 7, pattern 727
    state = pattern.state;
    expect(pattern.event).toMatchObject({
      type: "pattern",
      pattern: "727",
      referencePair: "27",
      opTrigger: "07",
    });

    const ldp = advanceX2XScanner(state, x2xTick(1234.05), true); // next tick's digit 5
    state = ldp.state;
    expect(ldp.event).toMatchObject({ type: "ldp", ldp: 5 });

    const trigger = advanceX2XScanner(state, x2xTick(1239.07), true);
    expect(trigger.event).toMatchObject({ type: "trigger", opTrigger: "07", ldp: 5 });
  });

  it("counts only eligible ticks in the ten-tick OP window", () => {
    expect(calculateX2XOpTrigger("27")).toBe("07");
    expect(calculateX2XOpTrigger("20")).toBe("00");
    expect(calculateX2XOpTrigger("35")).toBe("15");
    expect(calculateX2XOpTrigger("42")).toBe("22");
    expect(calculateX2XOpTrigger("19")).toBeNull();
    expect(lastTwoQuoteDigits(1234.07, 2)).toBe("07");

    let state = createX2XScannerState();
    for (const quote of [1234.15, 1234.12, 1234.25, 1234.68]) {
      state = advanceX2XScanner(state, x2xTick(quote), true).state;
    }

    const paused = advanceX2XScanner(state, x2xTick(1234.05), false);
    expect(paused.event).toBeNull();
    expect(paused.state.signal?.eligibleTicksRemaining).toBe(10);

    state = paused.state;
    for (let tick = 0; tick < 9; tick++) {
      const step = advanceX2XScanner(state, x2xTick(1234.11), true);
      state = step.state;
      expect(step.event).toBeNull();
    }

    const tenth = advanceX2XScanner(state, x2xTick(1234.11), true);
    expect(tenth.event).toMatchObject({ type: "expired", ldp: 8 });
    expect(tenth.state.signal).toBeNull();
  });

  it("fires on the tenth eligible tick and ignores later patterns while one signal is active", () => {
    let state = createX2XScannerState();
    for (const quote of [1234.15, 1234.12, 1234.25, 1234.68]) {
      state = advanceX2XScanner(state, x2xTick(quote), true).state;
    }

    for (const quote of [
      1234.14, 1234.12, 1234.14, 1234.11, 1234.11, 1234.11, 1234.11, 1234.11, 1234.11,
    ]) {
      const step = advanceX2XScanner(state, x2xTick(quote), true);
      state = step.state;
      expect(step.event).toBeNull();
    }

    expect(state.recentDigits).toEqual([1, 1, 1]);
    const tenth = advanceX2XScanner(state, x2xTick(1234.05), true);
    expect(tenth.event).toMatchObject({ type: "trigger", eligibleTicksElapsed: 10, ldp: 8 });
    expect(tenth.state.signal).toBeNull();
  });

  it("simulates one-tick trades with the same scanner and reports payout-adjusted P/L as unavailable", () => {
    const replay = runX2XBacktest(
      [1234.15, 1234.12, 1234.25, 1234.68, 1234.05, 1234.18].map((quote) => x2xTick(quote)),
    );
    expect(replay).toMatchObject({
      totalTicks: 6,
      patternsDetected: 1,
      validSignals: 1,
      triggers: 1,
      executedTrades: 1,
      wins: 1,
      losses: 0,
      unsettledTrades: 0,
      netPnl: null,
    });
  });

  it("does not turn a repeated tick id into another digit, signal, or trade", () => {
    const seen = new Set<string>();
    expect(rememberUniqueX2XTick(seen, "tick-1")).toBe(true);
    expect(rememberUniqueX2XTick(seen, "tick-1")).toBe(false);

    const replay = runX2XBacktest([
      x2xTick(1234.15, "tick-1"),
      x2xTick(1234.12, "tick-1"), // duplicate message must not become digit 2
      x2xTick(1234.25, "tick-2"),
      x2xTick(1234.68, "tick-3"),
      x2xTick(1234.05, "tick-4"),
    ]);
    expect(replay.patternsDetected).toBe(0);
    expect(replay.triggers).toBe(0);
  });

  it("cancels pending signals so a later OP quote cannot execute after stop or disable", () => {
    let state = createX2XScannerState();
    for (const quote of [1234.15, 1234.12, 1234.25]) {
      state = advanceX2XScanner(state, x2xTick(quote), true).state;
    }
    state = advanceX2XScanner(state, x2xTick(1234.68), true).state;

    const cancelled = cancelX2XScanner(state);
    expect(cancelled.cancelledSignal).toMatchObject({ phase: "awaiting-op", ldp: 8 });
    const afterStop = advanceX2XScanner(cancelled.state, x2xTick(1234.05), true);
    expect(afterStop.event).toBeNull();
    expect(afterStop.state.signal).toBeNull();
  });

  it("skips a pattern whose reference value cannot produce a non-negative two-digit trigger", () => {
    expect(calculateX2XOpTrigger("07")).toBeNull();
    let state = createX2XScannerState();
    state = advanceX2XScanner(state, x2xTick(1234.15), true).state; // 5
    state = advanceX2XScanner(state, x2xTick(1234.12), true).state; // 2
    const step = advanceX2XScanner(state, x2xTick(1234.05), true); // 5, reference 05
    expect(step.event).toMatchObject({
      type: "invalid-reference",
      pattern: "525",
      referencePair: "05",
    });
    expect(step.state.signal).toBeNull();
  });
});
