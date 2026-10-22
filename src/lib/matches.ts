// Matches strategy analysis for standard and 1-second Volatility 100 / 10 indices.

export type MarketSymbol = "R_100" | "R_10" | "1HZ100V" | "1HZ10V";

export interface MarketConfig {
  id: MarketSymbol;
  displayName: string;
  shortName: string;
  classicSymbol: string;
  optionsSymbol: string;
  pipDecimals: number;
}

export const MARKETS: Record<MarketSymbol, MarketConfig> = {
  R_100: {
    id: "R_100",
    displayName: "Volatility 100 Index",
    shortName: "Vol 100",
    classicSymbol: "R_100",
    optionsSymbol: "R_100",
    pipDecimals: 2,
  },
  R_10: {
    id: "R_10",
    displayName: "Volatility 10 Index",
    shortName: "Vol 10",
    classicSymbol: "R_10",
    optionsSymbol: "R_10",
    pipDecimals: 3,
  },
  "1HZ100V": {
    id: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    shortName: "Vol 100 (1s)",
    classicSymbol: "1HZ100V",
    optionsSymbol: "1HZ100V",
    pipDecimals: 2,
  },
  "1HZ10V": {
    id: "1HZ10V",
    displayName: "Volatility 10 (1s) Index",
    shortName: "Vol 10 (1s)",
    classicSymbol: "1HZ10V",
    optionsSymbol: "1HZ10V",
    pipDecimals: 3,
  },
};

export const MARKET_LIST: MarketConfig[] = [
  MARKETS.R_100,
  MARKETS.R_10,
  MARKETS["1HZ100V"],
  MARKETS["1HZ10V"],
];

export function getMarketConfig(symbol?: string): MarketConfig {
  return MARKET_LIST.find((market) => market.id === symbol) ?? MARKETS.R_100;
}

/** Preferred Deriv symbol for the active connection, plus a fallback for the other API. */
export function marketTradeSymbols(
  market: MarketConfig,
  mode: "otp" | "classic" | null,
): { preferred: string; fallback: string } {
  if (mode === "otp") {
    return { preferred: market.optionsSymbol, fallback: market.classicSymbol };
  }
  return { preferred: market.classicSymbol, fallback: market.optionsSymbol };
}

export const CLASSIC_SYMBOL = "R_100";
export const OPTIONS_SYMBOL = "R_100";
/** @deprecated Prefer CLASSIC_SYMBOL / OPTIONS_SYMBOL by connection mode */
export const SYMBOL = CLASSIC_SYMBOL;
export const DISPLAY_NAME = "Volatility 100";
export const PIP_DECIMALS = 2;
export const MARTINGALE_MULTIPLIER = 1.5;
export const MAX_DIFF = 0.3; // difference between most and second most digit must not exceed 0.3% by default
export const WINDOW = 1000;

/** Base stake is multiplied by 1.5 for each consecutive settled loss. */
export function calculateMartingaleStake(
  baseStake: number,
  consecutiveLosses: number,
  enabled: boolean,
): number {
  if (!Number.isFinite(baseStake) || baseStake <= 0) return 0;
  const steps = enabled ? Math.max(0, Math.floor(consecutiveLosses)) : 0;
  const amount = baseStake * Math.pow(MARTINGALE_MULTIPLIER, steps);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : 0;
}

/**
 * Extract the last digit from a quote using the selected market's pip precision.
 */
export function lastDigit(quote: number, decimals = PIP_DECIMALS): number {
  const s = quote.toFixed(decimals);
  return Number(s[s.length - 1]);
}

export interface Analysis {
  total: number;
  counts: number[];
  percents: number[]; // index 0-9
  most: number; // most appearing digit
  second: number; // second most appearing digit
  mostPct: number;
  secondPct: number;
  diff: number; // mostPct - secondPct
  ready: boolean; // strictly total >= WINDOW (1,000 ticks)
  ok: boolean; // ready && diff <= maxDiff
}

/**
 * Compute frequency and percentage distribution of digits 0-9 across the last 1,000 ticks.
 * Determines most and second most appearing digits and verifies if spread <= maxDiff (defaults to 0.3%).
 * Strictly requires at least 1,000 ticks buffered before condition (ok) can be met.
 */
export function analyze(digits: number[], maxDiff: number = MAX_DIFF): Analysis {
  // Always evaluate against the rolling last 1,000 ticks
  const windowDigits = digits.length > WINDOW ? digits.slice(-WINDOW) : digits;
  const counts = new Array(10).fill(0);
  for (const d of windowDigits) {
    if (d >= 0 && d <= 9) counts[d]++;
  }
  const total = windowDigits.length;
  const percents = counts.map((c) => (total > 0 ? (c / total) * 100 : 0));

  const order = percents
    .map((p, d) => ({ p, d }))
    .sort((a, b) => b.p - a.p || a.d - b.d);

  const first = order[0] || { p: 0, d: 0 };
  const runner = order[1] || { p: 0, d: 1 };

  const most = first.d;
  const second = runner.d;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const mostPct = round3(first.p);
  const secondPct = round3(runner.p);
  const diff = round3(mostPct - secondPct);
  const ready = total >= WINDOW;

  return {
    total,
    counts,
    percents,
    most,
    second,
    mostPct,
    secondPct,
    diff,
    ready,
    ok: ready && diff <= maxDiff,
  };
}

/**
 * Trade entry condition:
 * 1. Exactly 1,000 ticks must have been analyzed (a.ready).
 * 2. Spread condition must be satisfied (diff <= 0.3% and a.ok).
 * 3. The current incoming digit must match the most appearing digit (entry point).
 */
export function shouldEnter(a: Analysis, currentDigit: number): boolean {
  return a.ready && a.ok && currentDigit === a.most;
}
