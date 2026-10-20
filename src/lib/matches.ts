// Matches strategy analysis for Volatility 100 (R_100).
export const SYMBOL = "R_100";
export const PIP_DECIMALS = 2;
export const MAX_DIFF = 0.3; // difference between most and second most digit must not exceed 0.3%
export const MAX_RUNS = 3;   // exactly 3 runs per cycle
export const WINDOW = 1000;

/**
 * Extract the last digit from a price quote using pip decimal precision (2 decimals for Volatility 100).
 */
export function lastDigit(quote: number, decimals = PIP_DECIMALS): number {
  const s = quote.toFixed(decimals);
  return Number(s[s.length - 1]);
}

export interface Analysis {
  total: number;
  counts: number[];
  percents: number[]; // index 0-9
  most: number;       // most appearing digit
  second: number;     // second most appearing digit
  mostPct: number;
  secondPct: number;
  diff: number;       // mostPct - secondPct
  ok: boolean;        // diff <= MAX_DIFF
}

/**
 * Compute frequency and percentage distribution of digits 0-9
 * Determines most and second most appearing digits and verifies if spread <= 0.3%.
 */
export function analyze(digits: number[]): Analysis {
  const counts = new Array(10).fill(0);
  for (const d of digits) {
    if (d >= 0 && d <= 9) counts[d]++;
  }
  const total = digits.length;
  const percents = counts.map((c) => (total > 0 ? (c / total) * 100 : 0));

  const order = percents
    .map((p, d) => ({ p, d }))
    .sort((a, b) => b.p - a.p || a.d - b.d);

  const first = order[0] || { p: 0, d: 0 };
  const runner = order[1] || { p: 0, d: 1 };

  const most = first.d;
  const second = runner.d;
  const diff = Math.round((first.p - runner.p) * 1000) / 1000;

  return {
    total,
    counts,
    percents,
    most,
    second,
    mostPct: first.p,
    secondPct: runner.p,
    diff,
    ok: total > 0 && diff <= MAX_DIFF,
  };
}

/**
 * Trade entry condition:
 * Spread condition must be satisfied (diff <= 0.3%)
 * AND the current incoming digit must match the most appearing digit (entry point).
 */
export function shouldEnter(a: Analysis, currentDigit: number): boolean {
  return a.ok && currentDigit === a.most;
}
