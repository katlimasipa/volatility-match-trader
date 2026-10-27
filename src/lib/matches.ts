// Matches strategy analysis for Deriv standard and 1-second Volatility indices.

export type MarketSymbol =
  | "R_100"
  | "R_75"
  | "R_50"
  | "R_25"
  | "R_10"
  | "1HZ100V"
  | "1HZ90V"
  | "1HZ75V"
  | "1HZ50V"
  | "1HZ30V"
  | "1HZ25V"
  | "1HZ15V"
  | "1HZ10V"
  | "1HZ150V"
  | "1HZ250V";

export interface MarketConfig {
  id: MarketSymbol;
  displayName: string;
  shortName: string;
  classicSymbol: string;
  optionsSymbol: string;
  pipDecimals: number;
}

export type SpreadComparison = "exact" | "at_most";

export const MARKETS: Record<MarketSymbol, MarketConfig> = {
  R_100: {
    id: "R_100",
    displayName: "Volatility 100 Index",
    shortName: "Vol 100",
    classicSymbol: "R_100",
    optionsSymbol: "R_100",
    pipDecimals: 2,
  },
  R_75: {
    id: "R_75",
    displayName: "Volatility 75 Index",
    shortName: "Vol 75",
    classicSymbol: "R_75",
    optionsSymbol: "R_75",
    pipDecimals: 2,
  },
  R_50: {
    id: "R_50",
    displayName: "Volatility 50 Index",
    shortName: "Vol 50",
    classicSymbol: "R_50",
    optionsSymbol: "R_50",
    pipDecimals: 4,
  },
  R_25: {
    id: "R_25",
    displayName: "Volatility 25 Index",
    shortName: "Vol 25",
    classicSymbol: "R_25",
    optionsSymbol: "R_25",
    pipDecimals: 3,
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
  "1HZ75V": {
    id: "1HZ75V",
    displayName: "Volatility 75 (1s) Index",
    shortName: "Vol 75 (1s)",
    classicSymbol: "1HZ75V",
    optionsSymbol: "1HZ75V",
    pipDecimals: 2,
  },
  "1HZ50V": {
    id: "1HZ50V",
    displayName: "Volatility 50 (1s) Index",
    shortName: "Vol 50 (1s)",
    classicSymbol: "1HZ50V",
    optionsSymbol: "1HZ50V",
    pipDecimals: 2,
  },
  "1HZ25V": {
    id: "1HZ25V",
    displayName: "Volatility 25 (1s) Index",
    shortName: "Vol 25 (1s)",
    classicSymbol: "1HZ25V",
    optionsSymbol: "1HZ25V",
    pipDecimals: 2,
  },
  "1HZ15V": {
    id: "1HZ15V",
    displayName: "Volatility 15 (1s) Index",
    shortName: "Vol 15 (1s)",
    classicSymbol: "1HZ15V",
    optionsSymbol: "1HZ15V",
    pipDecimals: 3,
  },
  "1HZ30V": {
    id: "1HZ30V",
    displayName: "Volatility 30 (1s) Index",
    shortName: "Vol 30 (1s)",
    classicSymbol: "1HZ30V",
    optionsSymbol: "1HZ30V",
    pipDecimals: 3,
  },
  "1HZ90V": {
    id: "1HZ90V",
    displayName: "Volatility 90 (1s) Index",
    shortName: "Vol 90 (1s)",
    classicSymbol: "1HZ90V",
    optionsSymbol: "1HZ90V",
    pipDecimals: 3,
  },
  "1HZ150V": {
    id: "1HZ150V",
    displayName: "Volatility 150 (1s) Index",
    shortName: "Vol 150 (1s)",
    classicSymbol: "1HZ150V",
    optionsSymbol: "1HZ150V",
    pipDecimals: 2,
  },
  "1HZ250V": {
    id: "1HZ250V",
    displayName: "Volatility 250 (1s) Index",
    shortName: "Vol 250 (1s)",
    classicSymbol: "1HZ250V",
    optionsSymbol: "1HZ250V",
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

export const MARKET_GROUPS: { label: string; markets: MarketConfig[] }[] = [
  {
    label: "STANDARD",
    markets: [MARKETS.R_10, MARKETS.R_25, MARKETS.R_50, MARKETS.R_75, MARKETS.R_100],
  },
  {
    label: "1 SECOND",
    markets: [
      MARKETS["1HZ10V"],
      MARKETS["1HZ15V"],
      MARKETS["1HZ25V"],
      MARKETS["1HZ30V"],
      MARKETS["1HZ50V"],
      MARKETS["1HZ75V"],
      MARKETS["1HZ90V"],
      MARKETS["1HZ100V"],
      MARKETS["1HZ150V"],
      MARKETS["1HZ250V"],
    ],
  },
];

export const MARKET_LIST: MarketConfig[] = MARKET_GROUPS.flatMap((group) => group.markets);
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
export const MAX_DIFF = 0.3; // exact spread-difference target by default
export const WINDOW = 1000;

export interface DigitPrediction {
  digit: number;
  confidence: number;
  method: "all-digit frequency" | "recent-500 frequency" | "recent-250 frequency";
  selectedStrategy: "all-digit frequency" | "recent-500 frequency" | "recent-250 frequency";
  contextSamples: number;
  trainingTicks: number;
  validationAccuracy: number;
  baselineAccuracy: number;
  validationForecasts: number;
  edgeDetected: boolean;
}

type PredictionMethod = DigitPrediction["method"];

function predictFromFrequency(
  training: number[],
  method: PredictionMethod,
): Omit<
  DigitPrediction,
  | "trainingTicks"
  | "validationAccuracy"
  | "baselineAccuracy"
  | "validationForecasts"
  | "edgeDetected"
  | "selectedStrategy"
> {
  const allDigitCounts = new Array(10).fill(0) as number[];
  for (const digit of training) allDigitCounts[digit] = (allDigitCounts[digit] ?? 0) + 1;
  const allDigitPrior = allDigitCounts.map((count) => count / training.length);

  let contextCounts = allDigitCounts;
  let contextSamples = training.length;
  let smoothingWeight = 0;
  if (method !== "all-digit frequency") {
    const windowSize = method === "recent-500 frequency" ? 500 : 250;
    const recentTicks = training.slice(-windowSize);
    contextCounts = new Array(10).fill(0) as number[];
    for (const digit of recentTicks) contextCounts[digit] = (contextCounts[digit] ?? 0) + 1;
    contextSamples = recentTicks.length;
    smoothingWeight = method === "recent-500 frequency" ? 50 : 25;
  }

  const denominator = contextSamples + smoothingWeight;
  const probabilities = contextCounts.map(
    (count, digit) => (count + (allDigitPrior[digit] ?? 0) * smoothingWeight) / denominator,
  );
  const predictedDigit = probabilities.reduce(
    (bestDigit, probability, digit) =>
      probability > (probabilities[bestDigit] ?? 0) ? digit : bestDigit,
    0,
  );

  return {
    digit: predictedDigit,
    confidence: (probabilities[predictedDigit] ?? 0) * 100,
    method,
    contextSamples,
  };
}

/**
 * Compare overall and recency-weighted digit frequencies with a chronological
 * replay of the latest 250 ticks. The models use only individual digit counts,
 * never digit sequences or transitions. A recent-frequency model must beat the
 * all-digit baseline by at least two percentage points before it is selected.
 */
export function predictNextDigit(digits: number[]): DigitPrediction | null {
  const training = digits
    .slice(-WINDOW)
    .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
  if (training.length < WINDOW) return null;

  const methods: PredictionMethod[] = [
    "all-digit frequency",
    "recent-500 frequency",
    "recent-250 frequency",
  ];
  const validationStart = training.length - 250;
  const validationForecasts = training.length - validationStart;
  const scores = new Map<PredictionMethod, number>(methods.map((method) => [method, 0]));

  for (let targetIndex = validationStart; targetIndex < training.length; targetIndex++) {
    const pastTicks = training.slice(0, targetIndex);
    const actualDigit = training[targetIndex];
    for (const method of methods) {
      if (predictFromFrequency(pastTicks, method).digit === actualDigit) {
        scores.set(method, (scores.get(method) ?? 0) + 1);
      }
    }
  }

  const baselineCorrect = scores.get("all-digit frequency") ?? 0;
  const bestRecentMethod = methods
    .slice(1)
    .reduce<PredictionMethod>(
      (best, method) => ((scores.get(method) ?? 0) > (scores.get(best) ?? 0) ? method : best),
      "all-digit frequency",
    );
  const minimumImprovement = Math.max(5, Math.ceil(validationForecasts * 0.02));
  const edgeDetected = (scores.get(bestRecentMethod) ?? 0) >= baselineCorrect + minimumImprovement;
  const selectedStrategy = edgeDetected ? bestRecentMethod : "all-digit frequency";
  const prediction = predictFromFrequency(training, selectedStrategy);

  return {
    ...prediction,
    selectedStrategy,
    trainingTicks: training.length,
    validationAccuracy: Math.round(
      ((scores.get(selectedStrategy) ?? 0) / validationForecasts) * 100,
    ),
    baselineAccuracy: Math.round((baselineCorrect / validationForecasts) * 100),
    validationForecasts,
    edgeDetected,
  };
}
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

export {
  advanceX2XScanner,
  calculateX2XOpTrigger,
  createX2XScannerState,
  lastTwoQuoteDigits,
  runX2XBacktest,
  type X2XBacktestResult,
  type X2XQuoteDigit,
  type X2XScannerEvent,
  type X2XScannerSignal,
  type X2XScannerState,
  type X2XScannerStep,
} from "./x2x-strategy";

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
  ok: boolean; // ready && diff exactly matches the configured target
}

/**
 * Spread values are rounded to three decimals before comparison. Exact mode
 * uses a tiny floating-point tolerance; at_most compares directly to the cap.
 */
export function spreadMatchesThreshold(
  diff: number,
  threshold: number,
  comparison: SpreadComparison = "exact",
): boolean {
  if (!Number.isFinite(diff) || !Number.isFinite(threshold)) return false;
  return comparison === "at_most" ? diff <= threshold : Math.abs(diff - threshold) < 1e-9;
}

/**
 * Compute frequency and percentage distribution of digits 0-9 across the last 1,000 ticks.
 * Determines the most and second most appearing digits and verifies their spread
 * against the configured exact target or equal/under cap (defaults to exact 0.3%).
 * Strictly requires at least 1,000 ticks buffered before condition (ok) can be met.
 */
export function analyze(
  digits: number[],
  targetDiff: number = MAX_DIFF,
  comparison: SpreadComparison = "exact",
): Analysis {
  // Always evaluate against the rolling last 1,000 ticks
  const windowDigits = digits.length > WINDOW ? digits.slice(-WINDOW) : digits;
  const counts = new Array(10).fill(0);
  for (const d of windowDigits) {
    if (d >= 0 && d <= 9) counts[d]++;
  }
  const total = windowDigits.length;
  const percents = counts.map((c) => (total > 0 ? (c / total) * 100 : 0));

  const order = percents.map((p, d) => ({ p, d })).sort((a, b) => b.p - a.p || a.d - b.d);

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
    ok: ready && spreadMatchesThreshold(diff, targetDiff, comparison),
  };
}

/**
 * Trade entry condition:
 * 1. Exactly 1,000 ticks must have been analyzed (a.ready).
 * 2. The configured spread condition must be satisfied (a.ok).
 * 3. The current incoming digit must match the most appearing digit (entry point).
 */
export function shouldEnter(a: Analysis, currentDigit: number): boolean {
  return a.ready && a.ok && currentDigit === a.most;
}
