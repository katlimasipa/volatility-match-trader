// Matches strategy analysis for Volatility 100 (R_100).
export const SYMBOL = "R_100";
export const PIP_DECIMALS = 2;
export const MAX_DIFF = 0.3; // percentage points between most and second most digit
export const MAX_RUNS = 3;
export const WINDOW = 1000;

export function lastDigit(quote: number, decimals = PIP_DECIMALS): number {
  const s = quote.toFixed(decimals);
  return Number(s[s.length - 1]);
}

export interface Analysis {
  total: number;
  percents: number[]; // index = digit
  most: number;
  second: number;
  mostPct: number;
  secondPct: number;
  diff: number;
  ok: boolean;
}

export function analyze(digits: number[]): Analysis {
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const total = digits.length;
  const percents = counts.map((c) => (total ? (c / total) * 100 : 0));
  const order = percents
    .map((p, d) => ({ p, d }))
    .sort((a, b) => b.p - a.p || a.d - b.d);
  const first = order[0]!;
  const runner = order[1]!;
  const most = first.d;
  const second = runner.d;
  const diff = Math.round((first.p - runner.p) * 1000) / 1000;
  return {
    total,
    percents,
    most,
    second,
    mostPct: first.p,
    secondPct: runner.p,
    diff,
    ok: total > 0 && diff <= MAX_DIFF,
  };
}

/** Enter when the current tick's digit equals the most appearing digit and the spread is within limit. */
export function shouldEnter(a: Analysis, currentDigit: number): boolean {
  return a.ok && currentDigit === a.most;
}
