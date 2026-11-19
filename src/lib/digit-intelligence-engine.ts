import { MARKET_LIST, type MarketSymbol } from "@/lib/matches";

export const RESEARCH_WINDOWS = [100, 250, 500, 1000, 5000] as const;
export type ResearchWindow = (typeof RESEARCH_WINDOWS)[number];

export const RESEARCH_MARKETS: MarketSymbol[] = MARKET_LIST.map((market) => market.id);
export type ResearchMarket = MarketSymbol;

export const RESEARCH_STRATEGIES = [
  "rolling_frequency",
  "mad",
  "least_appearing",
  "transition_matrix",
  "markov_chain",
  "two_digit_sequence",
  "three_digit_sequence",
  "conditional_probability",
  "multi_model_agreement",
  "edge_validation",
] as const;
export type ResearchStrategyId = (typeof RESEARCH_STRATEGIES)[number];

export const ENSEMBLE_EXPERTS = [
  "rolling_frequency",
  "mad",
  "least_appearing",
  "streak_context",
  "transition_matrix",
  "markov_first",
  "markov_second",
  "two_digit_sequence",
  "three_digit_sequence",
  "conditional_probability",
] as const;
export type EnsembleExpertId = (typeof ENSEMBLE_EXPERTS)[number];

export type ResearchTarget = "auto" | number;

export interface ResearchStrategySettings {
  enabled: boolean;
  window: ResearchWindow;
  minimumSamples: number;
  minimumConfidence: number;
  target: ResearchTarget;
}

export type ResearchSettings = Record<ResearchStrategyId, ResearchStrategySettings>;

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

export interface DigitFrequency {
  digit: number;
  count: number;
  percentage: number;
  expectedCount: number;
  deviation: number;
  interval: ConfidenceInterval;
  pValue: number | null;
  adjustedPValue: number | null;
  representation: "over" | "under" | "average";
}

export interface TransitionCell {
  digit: number;
  count: number;
  samples: number;
  probability: number;
  smoothedProbability: number;
  baselineProbability: number;
  deviation: number;
  interval: ConfidenceInterval;
}

export interface TransitionRow {
  previousDigit: number;
  samples: number;
  cells: TransitionCell[];
  mostFrequentNextDigit: number | null;
}

export interface RankedDigitSequence {
  context: string;
  order: 2 | 3;
  samples: number;
  counts: number[];
  nextDigit: number;
  probability: number;
}

export interface ContextAnalysis {
  order: 1 | 2 | 3;
  context: string;
  samples: number;
  counts: number[];
  probabilities: number[];
  predictedDigit: number | null;
  rawProbability: number | null;
  interval: ConfidenceInterval | null;
}

export interface ResearchModuleOutput {
  id: ResearchStrategyId;
  name: string;
  enabled: boolean;
  descriptiveOnly: boolean;
  window: ResearchWindow;
  sampleSize: number;
  contextSamples: number;
  targetDigit: number | null;
  observationDigit: number | null;
  ensembleVotes: Array<{
    id: EnsembleExpertId;
    digit: number;
    probability: number;
    samples: number;
  }>;
  agreementCount: number;
  rankedDigits: number[];
  estimatedProbability: number | null;
  probabilityInterval: ConfidenceInterval | null;
  probabilities: number[];
  signalEligible: false;
  status: string;
  reason: string;
}

export interface DigitResearchAnalysis {
  marketScope: "one market only";
  requestedWindow: ResearchWindow;
  sampleSize: number;
  ready: boolean;
  frequencies: DigitFrequency[];
  frequencyRanking: DigitFrequency[];
  mostAppearing: DigitFrequency[];
  leastAppearing: DigitFrequency[];
  frequencyChanges: Array<{ digit: number; earlierPercentage: number; recentPercentage: number }>;
  absenceStreaks: number[];
  currentRunDigit: number | null;
  currentRunLength: number;
  transitionMatrix: TransitionRow[];
  markovOrder1: ContextAnalysis;
  markovOrder2: ContextAnalysis;
  sequenceOrder2: ContextAnalysis;
  sequenceOrder3: ContextAnalysis;
  activeSequence: ContextAnalysis | null;
  modules: ResearchModuleOutput[];
  ensembleWeights: Partial<Record<EnsembleExpertId, number>> | null;
  signalEligible: false;
  liveTradingStatus: string;
}

export interface SegmentPerformance {
  predictions: number;
  correct: number;
  incorrect: number;
  accuracy: number | null;
  interval: ConfidenceInterval | null;
  pValue: number | null;
  adjustedPValue: number | null;
  maxLosingStreak: number;
  maxDrawdownStakes: number | null;
}

export interface ResearchModuleValidation {
  id: ResearchStrategyId;
  descriptiveOnly: boolean;
  development: SegmentPerformance;
  validation: SegmentPerformance;
  finalTest: SegmentPerformance;
  status: "descriptive" | "insufficient data" | "not validated" | "validated";
  expectedValue: null;
  liveEligible: false;
  reason: string;
}

export interface DigitResearchBacktest {
  totalTicks: number;
  evaluatedTicks: number;
  development: { startIndex: number; endIndex: number; performance: number };
  validation: { startIndex: number; endIndex: number; performance: number };
  finalTest: { startIndex: number; endIndex: number; performance: number };
  randomBaseline: number;
  frequencyBaseline: SegmentPerformance;
  models: ResearchModuleValidation[];
  ensembleWeights: Partial<Record<EnsembleExpertId, number>>;
  walkForward: true;
  lookAheadBias: false;
  payoutAdjustedExpectedValue: null;
  liveTradingStatus: string;
}

export interface EnsembleTrainingExample {
  targetDigit: number;
  distributions: Partial<Record<EnsembleExpertId, number[]>>;
}

export interface DigitResearchTradeGateInput {
  validated: boolean;
  estimate: number;
  lowerConfidenceBound: number;
  minimumEstimate: number;
  stake: number;
  proposalAsk: number;
  proposalPayout: number;
  balance: number;
  dailyTrades: number;
  dailyLoss: number;
  consecutiveLosses: number;
  openContracts: number;
  testingBalance: number;
  maxDailyTrades?: number;
  maxDailyLossPercent?: number;
  maxConsecutiveLosses?: number;
  minimumExpectedValue?: number;
}

export interface DigitResearchTradeAssessment {
  eligible: boolean;
  reason: string;
  expectedValue: number | null;
  breakEvenProbability: number | null;
}

const DIGIT_COUNT = 10;
const RANDOM_BASELINE = 0.1;
const WILSON_Z_95 = 1.959963984540054;
export const RESEARCH_MULTIPLE_TEST_FAMILY_SIZE =
  RESEARCH_MARKETS.length * RESEARCH_WINDOWS.length * 10 * 10;
const MULTIPLE_TEST_FAMILY_SIZE = RESEARCH_MULTIPLE_TEST_FAMILY_SIZE;
const MINIMUM_VALIDATION_PREDICTIONS = 100;
const NAMES: Record<ResearchStrategyId, string> = {
  rolling_frequency: "Rolling digit frequency",
  mad: "Most appearing digit",
  least_appearing: "Least appearing digit",
  transition_matrix: "Digit transition matrix",
  markov_chain: "Markov chain",
  two_digit_sequence: "Two-digit sequence",
  three_digit_sequence: "Three-digit sequence",
  conditional_probability: "Conditional probability",
  multi_model_agreement: "Multi-model agreement",
  edge_validation: "Statistical edge validation",
};

const DESCRIPTIVE_IDS: ResearchStrategyId[] = ["rolling_frequency", "mad", "least_appearing"];

export function createDefaultResearchSettings(): ResearchSettings {
  return Object.fromEntries(
    RESEARCH_STRATEGIES.map((id) => [
      id,
      {
        enabled: true,
        window: id === "rolling_frequency" || id === "mad" || id === "least_appearing" ? 1000 : 500,
        minimumSamples: id === "three_digit_sequence" ? 10 : id === "two_digit_sequence" ? 8 : 30,
        minimumConfidence: 12,
        target: "auto",
      },
    ]),
  ) as ResearchSettings;
}

function isDigit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < DIGIT_COUNT;
}

function validDigits(input: number[]): number[] {
  return input.filter(isDigit);
}

function emptyCounts(): number[] {
  return Array<number>(DIGIT_COUNT).fill(0);
}

function mostLikely(probabilities: number[]): number | null {
  if (!probabilities.length || probabilities.every((value) => value <= 0)) return null;
  let best = 0;
  for (let digit = 1; digit < Math.min(DIGIT_COUNT, probabilities.length); digit++) {
    if ((probabilities[digit] ?? 0) > (probabilities[best] ?? 0)) best = digit;
  }
  return best;
}

export function wilsonInterval(successes: number, total: number): ConfidenceInterval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) return null;
  const n = Math.floor(total);
  const x = Math.max(0, Math.min(n, Math.floor(successes)));
  const p = x / n;
  const z2 = WILSON_Z_95 ** 2;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (WILSON_Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** One-sided exact binomial test for improvement above a 10% baseline. */
export function binomialUpperTailPValue(
  successes: number,
  total: number,
  baseline = RANDOM_BASELINE,
): number | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0) return null;
  const x = Math.max(0, Math.min(total, successes));
  if (x === 0) return 1;

  const mode = Math.floor((total + 1) * baseline);
  const weights = Array<number>(total + 1).fill(0);
  weights[mode] = 1;
  for (let k = mode; k < total; k++) {
    weights[k + 1] = (weights[k] ?? 0) * ((total - k) / (k + 1)) * (baseline / (1 - baseline));
  }
  for (let k = mode; k > 0; k--) {
    weights[k - 1] = (weights[k] ?? 0) * (k / (total - k + 1)) * ((1 - baseline) / baseline);
  }
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  const tail = weights.slice(x).reduce((sum, weight) => sum + weight, 0);
  return denominator > 0 ? Math.min(1, tail / denominator) : null;
}

function adjustedPValue(pValue: number | null): number | null {
  return pValue === null ? null : Math.min(1, pValue * MULTIPLE_TEST_FAMILY_SIZE);
}

function digitCounts(digits: number[]): number[] {
  const counts = emptyCounts();
  digits.forEach((digit) => {
    if (isDigit(digit)) counts[digit] = (counts[digit] ?? 0) + 1;
  });
  return counts;
}

function absenceStreaks(digits: number[]): number[] {
  const lastSeen = Array<number>(DIGIT_COUNT).fill(-1);
  digits.forEach((digit, index) => {
    if (isDigit(digit)) lastSeen[digit] = index;
  });
  return lastSeen.map((last) => (last < 0 ? digits.length : digits.length - last - 1));
}

function frequencyRows(digits: number[]): DigitFrequency[] {
  const counts = digitCounts(digits);
  const expected = digits.length / DIGIT_COUNT;
  return counts.map((count, digit) => {
    const pValue = binomialUpperTailPValue(count, digits.length);
    return {
      digit,
      count,
      percentage: digits.length ? (count / digits.length) * 100 : 0,
      expectedCount: expected,
      deviation: count - expected,
      interval: wilsonInterval(count, digits.length) ?? { lower: 0, upper: 1 },
      pValue,
      adjustedPValue: adjustedPValue(pValue),
      representation: count === expected ? "average" : count > expected ? "over" : "under",
    };
  });
}

function frequenciesByWindow(digits: number[]): Array<{
  digit: number;
  earlierPercentage: number;
  recentPercentage: number;
}> {
  const split = Math.floor(digits.length / 2);
  const earlier = digits.slice(0, split);
  const recent = digits.slice(split);
  const earlierCounts = digitCounts(earlier);
  const recentCounts = digitCounts(recent);
  return Array.from({ length: DIGIT_COUNT }, (_, digit) => ({
    digit,
    earlierPercentage: earlier.length ? ((earlierCounts[digit] ?? 0) / earlier.length) * 100 : 0,
    recentPercentage: recent.length ? ((recentCounts[digit] ?? 0) / recent.length) * 100 : 0,
  }));
}

export function buildDigitTransitionMatrix(inputDigits: number[]): TransitionRow[] {
  const digits = validDigits(inputDigits);
  const counts = Array.from({ length: DIGIT_COUNT }, () => emptyCounts());
  const rowSamples = emptyCounts();
  const overall = digitCounts(digits);
  const prior = overall.map((count) => (count + 1) / (digits.length + DIGIT_COUNT));

  for (let index = 1; index < digits.length; index++) {
    const previous = digits[index - 1];
    const next = digits[index];
    if (!isDigit(previous) || !isDigit(next)) continue;
    const row = counts[previous];
    if (!row) continue;
    row[next] = (row[next] ?? 0) + 1;
    rowSamples[previous] = (rowSamples[previous] ?? 0) + 1;
  }

  return Array.from({ length: DIGIT_COUNT }, (_, previousDigit) => {
    const samples = rowSamples[previousDigit] ?? 0;
    const rowCounts = counts[previousDigit] ?? emptyCounts();
    const probabilities = samples ? rowCounts.map((count) => count / samples) : emptyCounts();
    return {
      previousDigit,
      samples,
      mostFrequentNextDigit: samples ? mostLikely(probabilities) : null,
      cells: rowCounts.map((count, digit) => ({
        digit,
        count,
        samples,
        probability: samples ? count / samples : 0,
        smoothedProbability: (count + 10 * (prior[digit] ?? RANDOM_BASELINE)) / (samples + 10),
        baselineProbability: RANDOM_BASELINE,
        deviation: (samples ? count / samples : 0) - RANDOM_BASELINE,
        interval: wilsonInterval(count, samples) ?? { lower: 0, upper: 1 },
      })),
    };
  });
}

/** Reports repeated two/three-digit contexts and their observed next digits. */
export function rankDigitSequences(
  inputDigits: number[],
  order: 2 | 3,
  minimumSamples = 2,
  limit = 10,
): RankedDigitSequence[] {
  const digits = validDigits(inputDigits);
  const followers = followersByLength(digits, order);
  return [...followers.entries()]
    .map(([context, counts]) => {
      const samples = counts.reduce((sum, count) => sum + count, 0);
      const nextDigit = mostLikely(counts) ?? 0;
      return {
        context,
        order,
        samples,
        counts,
        nextDigit,
        probability: samples ? (counts[nextDigit] ?? 0) / samples : 0,
      };
    })
    .filter((sequence) => sequence.samples >= Math.max(1, minimumSamples))
    .sort(
      (a, b) =>
        b.samples - a.samples ||
        b.probability - a.probability ||
        a.context.localeCompare(b.context),
    )
    .slice(0, Math.max(1, limit));
}

interface WindowStatistics {
  digits: number[];
  counts: number[];
  prior: number[];
  transitionCounts: number[][];
  transitionSamples: number[];
  pairFollowers: Map<string, number[]>;
  tripleFollowers: Map<string, number[]>;
}

function followersByLength(digits: number[], length: 2 | 3): Map<string, number[]> {
  const followers = new Map<string, number[]>();
  for (let index = length; index < digits.length; index++) {
    const context = digits.slice(index - length, index).join("");
    const next = digits[index];
    if (!isDigit(next)) continue;
    const counts = followers.get(context) ?? emptyCounts();
    counts[next] = (counts[next] ?? 0) + 1;
    followers.set(context, counts);
  }
  return followers;
}

function summarizeWindow(input: number[]): WindowStatistics {
  const digits = validDigits(input);
  const counts = digitCounts(digits);
  const prior = counts.map((count) => (count + 1) / (digits.length + DIGIT_COUNT));
  const transitionCounts = Array.from({ length: DIGIT_COUNT }, () => emptyCounts());
  const transitionSamples = emptyCounts();
  for (let index = 1; index < digits.length; index++) {
    const previous = digits[index - 1];
    const next = digits[index];
    if (!isDigit(previous) || !isDigit(next)) continue;
    const row = transitionCounts[previous];
    if (!row) continue;
    row[next] = (row[next] ?? 0) + 1;
    transitionSamples[previous] = (transitionSamples[previous] ?? 0) + 1;
  }
  return {
    digits,
    counts,
    prior,
    transitionCounts,
    transitionSamples,
    pairFollowers: followersByLength(digits, 2),
    tripleFollowers: followersByLength(digits, 3),
  };
}

function smoothedDistribution(
  counts: number[],
  samples: number,
  prior: number[],
  strength = 10,
): number[] {
  if (samples <= 0) return [...prior];
  return counts.map(
    (count, digit) => (count + strength * (prior[digit] ?? RANDOM_BASELINE)) / (samples + strength),
  );
}

function contextAnalysis(
  order: 1 | 2 | 3,
  context: string,
  counts: number[],
  samples: number,
  prior: number[],
  minimumSamples: number,
): ContextAnalysis {
  const probabilities = smoothedDistribution(counts, samples, prior);
  const rawBest = mostLikely(counts);
  const predictedDigit = samples >= minimumSamples ? mostLikely(probabilities) : null;
  return {
    order,
    context,
    samples,
    counts,
    probabilities,
    predictedDigit,
    rawProbability: rawBest === null || !samples ? null : (counts[rawBest] ?? 0) / samples,
    interval: rawBest === null || !samples ? null : wilsonInterval(counts[rawBest] ?? 0, samples),
  };
}

function weightedDistribution(
  weights: Partial<Record<EnsembleExpertId, number>>,
  distributions: Partial<Record<EnsembleExpertId, number[]>>,
): number[] | null {
  const available = ENSEMBLE_EXPERTS.filter(
    (id) =>
      (weights[id] ?? 0) > 0 &&
      Array.isArray(distributions[id]) &&
      distributions[id]?.length === DIGIT_COUNT,
  );
  const totalWeight = available.reduce((sum, id) => sum + (weights[id] ?? 0), 0);
  if (!available.length || totalWeight <= 0) return null;
  return Array.from({ length: DIGIT_COUNT }, (_, digit) =>
    available.reduce(
      (sum, id) => sum + ((weights[id] ?? 0) / totalWeight) * (distributions[id]?.[digit] ?? 0),
      0,
    ),
  );
}

function outputForStrategy(
  id: ResearchStrategyId,
  config: ResearchStrategySettings,
  summary: WindowStatistics,
  weights: Partial<Record<EnsembleExpertId, number>> | null,
  ensembleOverride?: {
    probabilities: number[] | null;
    contextSamples: number;
    experts: Partial<Record<EnsembleExpertId, number[]>>;
  },
): ResearchModuleOutput {
  const digits = summary.digits;
  const windowReady = digits.length >= config.window;
  const sortedHigh = summary.counts
    .map((count, digit) => ({ digit, count }))
    .sort((a, b) => b.count - a.count || a.digit - b.digit);
  const sortedLow = [...sortedHigh].sort((a, b) => a.count - b.count || a.digit - b.digit);
  const trailing1 = digits.at(-1);
  const trailing2 = digits.slice(-2).join("");
  const trailing3 = digits.slice(-3).join("");
  const oneCounts = isDigit(trailing1)
    ? (summary.transitionCounts[trailing1] ?? emptyCounts())
    : emptyCounts();
  const oneSamples = isDigit(trailing1) ? (summary.transitionSamples[trailing1] ?? 0) : 0;
  const pairCounts = summary.pairFollowers.get(trailing2) ?? emptyCounts();
  const pairSamples = pairCounts.reduce((sum, count) => sum + count, 0);
  const tripleCounts = summary.tripleFollowers.get(trailing3) ?? emptyCounts();
  const tripleSamples = tripleCounts.reduce((sum, count) => sum + count, 0);
  const transition = contextAnalysis(
    1,
    String(trailing1 ?? ""),
    oneCounts,
    oneSamples,
    summary.prior,
    config.minimumSamples,
  );
  const markovFirst = contextAnalysis(
    1,
    String(trailing1 ?? ""),
    oneCounts,
    oneSamples,
    summary.prior,
    config.minimumSamples,
  );
  const markovSecond = contextAnalysis(
    2,
    trailing2,
    pairCounts,
    pairSamples,
    summary.prior,
    config.minimumSamples,
  );
  const sequence2 = contextAnalysis(
    2,
    trailing2,
    pairCounts,
    pairSamples,
    summary.prior,
    config.minimumSamples,
  );
  const sequence3 = contextAnalysis(
    3,
    trailing3,
    tripleCounts,
    tripleSamples,
    summary.prior,
    config.minimumSamples,
  );
  const fallback = [sequence3, sequence2, markovFirst].find(
    (context) => context.predictedDigit !== null,
  );
  const conditional =
    fallback ??
    contextAnalysis(
      1,
      String(trailing1 ?? ""),
      oneCounts,
      oneSamples,
      summary.prior,
      config.minimumSamples,
    );
  const modelDistributions: Partial<Record<EnsembleExpertId, number[]>> = {};
  if (
    windowReady &&
    config.enabled &&
    (id === "multi_model_agreement" ||
      id === "rolling_frequency" ||
      id === "mad" ||
      id === "least_appearing")
  ) {
    const total = summary.counts.reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      const smoothed = smoothedDistribution(summary.counts, total, summary.prior);
      modelDistributions.rolling_frequency = smoothed;
      modelDistributions.mad = smoothed;
      const highest = Math.max(...summary.counts);
      const inverse = summary.counts.map((count) => highest - count + 1);
      const inverseTotal = inverse.reduce((sum, count) => sum + count, 0);
      modelDistributions.least_appearing = inverse.map((count) => count / inverseTotal);
    }
  }
  if (transition.samples >= config.minimumSamples)
    modelDistributions.transition_matrix = transition.probabilities;
  if (markovFirst.samples >= config.minimumSamples)
    modelDistributions.markov_first = markovFirst.probabilities;
  if (markovSecond.samples >= config.minimumSamples)
    modelDistributions.markov_second = markovSecond.probabilities;
  if (sequence2.samples >= config.minimumSamples)
    modelDistributions.two_digit_sequence = sequence2.probabilities;
  if (sequence3.samples >= config.minimumSamples)
    modelDistributions.three_digit_sequence = sequence3.probabilities;
  if (fallback) modelDistributions.conditional_probability = conditional.probabilities;
  const combined = ensembleOverride
    ? ensembleOverride.probabilities
    : weights
      ? weightedDistribution(weights, modelDistributions)
      : null;

  let probabilities = summary.prior;
  let contextSamples = digits.length;
  let reason = "Research output only; trading requires passed chronological holdout checks.";
  let descriptiveOnly = false;
  switch (id) {
    case "rolling_frequency":
    case "mad":
      probabilities = digits.length
        ? summary.counts.map((count) => count / digits.length)
        : summary.prior;
      break;
    case "least_appearing":
      probabilities = digits.length
        ? summary.counts.map((count) => count / digits.length)
        : summary.prior;
      break;
    case "transition_matrix":
      probabilities = transition.probabilities;
      contextSamples = transition.samples;
      break;
    case "markov_chain":
      if (markovSecond.predictedDigit !== null) {
        probabilities = markovSecond.probabilities;
        contextSamples = markovSecond.samples;
      } else {
        probabilities = markovFirst.probabilities;
        contextSamples = markovFirst.samples;
      }
      break;
    case "two_digit_sequence":
      probabilities = sequence2.probabilities;
      contextSamples = sequence2.samples;
      break;
    case "three_digit_sequence":
      probabilities = sequence3.probabilities;
      contextSamples = sequence3.samples;
      break;
    case "conditional_probability":
      probabilities = conditional.probabilities;
      contextSamples = conditional.samples;
      break;
    case "multi_model_agreement":
      probabilities = combined ?? summary.prior;
      contextSamples =
        ensembleOverride?.contextSamples ??
        (combined
          ? [
              transition.samples,
              markovFirst.samples,
              markovSecond.samples,
              sequence2.samples,
              sequence3.samples,
              conditional.samples,
            ].reduce((sum, samples) => sum + samples, 0)
          : 0);
      break;
    case "edge_validation":
      probabilities = summary.prior;
      contextSamples = 0;
      break;
  }

  if (DESCRIPTIVE_IDS.includes(id)) {
    descriptiveOnly = true;
    reason = "Descriptive only. This ranking is not a next-tick signal.";
  } else if (!config.enabled) {
    reason = "This research module is switched off.";
  } else if (id === "edge_validation") {
    reason = "Run the chronological 60/20/20 walk-forward check to evaluate evidence.";
  } else if (id === "multi_model_agreement" && !combined) {
    reason = "Model weights are fitted from development data during walk-forward validation.";
  } else if (
    contextSamples < config.minimumSamples &&
    id !== "rolling_frequency" &&
    id !== "mad" &&
    id !== "least_appearing"
  ) {
    reason = `Waiting for ${config.minimumSamples} observations in the active context.`;
  }

  const available =
    id === "edge_validation"
      ? false
      : id === "rolling_frequency" || id === "mad" || id === "least_appearing"
        ? windowReady
        : windowReady &&
          contextSamples >= config.minimumSamples &&
          (id !== "multi_model_agreement" || combined !== null);
  const diagnosticOnly = DESCRIPTIVE_IDS.includes(id);
  const automaticDigit =
    id === "least_appearing" ? (sortedLow[0]?.digit ?? null) : (sortedHigh[0]?.digit ?? null);
  const proposedDigit = config.target === "auto" ? mostLikely(probabilities) : config.target;
  const proposedProbability = proposedDigit === null ? 0 : (probabilities[proposedDigit] ?? 0);
  const targetDigit =
    id === "edge_validation" ||
    diagnosticOnly ||
    !available ||
    proposedProbability < config.minimumConfidence / 100
      ? null
      : proposedDigit;
  const observationDigit =
    !config.enabled || id === "edge_validation"
      ? null
      : diagnosticOnly
        ? config.target === "auto"
          ? ((id === "least_appearing" ? sortedLow[0]?.digit : sortedHigh[0]?.digit) ?? null)
          : config.target
        : targetDigit;
  const estimatedProbability = targetDigit === null ? null : (probabilities[targetDigit] ?? 0);
  if (!config.enabled) reason = "This research module is switched off.";
  if (config.enabled && available && !descriptiveOnly && id !== "edge_validation") {
    reason = `Candidate ${targetDigit} estimates ${(estimatedProbability ?? 0) * 100}% from historical evidence; not validated for trading.`;
  }

  return {
    id,
    name: NAMES[id],
    enabled: config.enabled,
    descriptiveOnly,
    window: config.window,
    sampleSize: digits.length,
    contextSamples,
    targetDigit,
    observationDigit,
    ensembleVotes:
      id === "multi_model_agreement"
        ? ENSEMBLE_EXPERTS.flatMap((expert) => {
            const distribution = ensembleOverride?.experts[expert] ?? modelDistributions[expert];
            if (!validProbabilityVector(distribution)) return [];
            const sampleByExpert: Record<EnsembleExpertId, number> = {
              rolling_frequency: digits.length,
              mad: digits.length,
              least_appearing: digits.length,
              streak_context: digits.length,
              transition_matrix: transition.samples,
              markov_first: markovFirst.samples,
              markov_second: markovSecond.samples,
              two_digit_sequence: sequence2.samples,
              three_digit_sequence: sequence3.samples,
              conditional_probability: conditional.samples,
            };
            const digit = mostLikely(distribution);
            return digit === null
              ? []
              : [
                  {
                    id: expert,
                    digit,
                    probability: distribution[digit] ?? 0,
                    samples: sampleByExpert[expert],
                  },
                ];
          })
        : [],
    agreementCount:
      id === "multi_model_agreement" && targetDigit !== null
        ? ENSEMBLE_EXPERTS.filter((expert) => {
            const distribution = ensembleOverride?.experts[expert] ?? modelDistributions[expert];
            return validProbabilityVector(distribution) && mostLikely(distribution) === targetDigit;
          }).length
        : 0,
    rankedDigits:
      diagnosticOnly && config.enabled && digits.length >= config.window
        ? (id === "least_appearing" ? sortedLow : sortedHigh).slice(0, 3).map((row) => row.digit)
        : [],
    estimatedProbability,
    probabilityInterval:
      targetDigit === null || id === "edge_validation" || id === "multi_model_agreement"
        ? null
        : wilsonInterval(
            id === "rolling_frequency" || id === "mad" || id === "least_appearing"
              ? (summary.counts[targetDigit] ?? 0)
              : id === "transition_matrix"
                ? (oneCounts[targetDigit] ?? 0)
                : id === "markov_chain"
                  ? ((markovSecond.predictedDigit !== null
                      ? pairCounts[targetDigit]
                      : oneCounts[targetDigit]) ?? 0)
                  : id === "two_digit_sequence"
                    ? (pairCounts[targetDigit] ?? 0)
                    : id === "three_digit_sequence"
                      ? (tripleCounts[targetDigit] ?? 0)
                      : (conditional.counts[targetDigit] ?? 0),
            id === "rolling_frequency" || id === "mad" || id === "least_appearing"
              ? digits.length
              : contextSamples,
          ),
    probabilities,
    signalEligible: false,
    status: !config.enabled
      ? "Disabled"
      : descriptiveOnly
        ? "Diagnostic only"
        : available
          ? "Research candidate · holdout validation required"
          : "Collecting sufficient observations",
    reason,
  };
}

function emptyContext(order: 1 | 2 | 3): ContextAnalysis {
  return {
    order,
    context: "",
    samples: 0,
    counts: emptyCounts(),
    probabilities: Array<number>(DIGIT_COUNT).fill(RANDOM_BASELINE),
    predictedDigit: null,
    rawProbability: null,
    interval: null,
  };
}

interface SnapshotCandidate {
  digit: number | null;
  probability: number | null;
  diagnosticDigit: number | null;
}

interface ResearchSnapshot {
  candidates: Record<ResearchStrategyId, SnapshotCandidate>;
  experts: Partial<Record<EnsembleExpertId, number[]>>;
}

function contextFromSummary(
  summary: WindowStatistics,
  settings: ResearchStrategySettings,
  order: 1 | 2 | 3,
): ContextAnalysis | null {
  if (!settings.enabled) return null;
  if (summary.digits.length < settings.window) return null;
  const last = summary.digits.at(-1);
  let context = "";
  let counts = emptyCounts();
  let samples = 0;
  if (order === 1 && isDigit(last)) {
    context = String(last);
    counts = summary.transitionCounts[last] ?? emptyCounts();
    samples = summary.transitionSamples[last] ?? 0;
  } else if (order === 2) {
    context = summary.digits.slice(-2).join("");
    counts = summary.pairFollowers.get(context) ?? emptyCounts();
    samples = counts.reduce((sum, count) => sum + count, 0);
  } else if (order === 3) {
    context = summary.digits.slice(-3).join("");
    counts = summary.tripleFollowers.get(context) ?? emptyCounts();
    samples = counts.reduce((sum, count) => sum + count, 0);
  }
  if (samples < settings.minimumSamples) return null;
  return contextAnalysis(order, context, counts, samples, summary.prior, settings.minimumSamples);
}

function absenceAgeBucket(age: number): number {
  if (age === 0) return 0;
  if (age <= 2) return 1;
  if (age <= 5) return 2;
  return 3;
}

/**
 * Estimates each digit's next-tick rate after its current absence streak.
 * A streak only contributes through historical conditional outcomes and is
 * shrunk toward the market's unconditional frequency; it is never a signal by
 * itself.
 */
function streakContextDistribution(
  digits: number[],
  prior: number[],
  minimumSamples: number,
): number[] | null {
  if (digits.length < 2) return null;
  const samples = Array.from({ length: DIGIT_COUNT }, () => Array<number>(4).fill(0));
  const successes = Array.from({ length: DIGIT_COUNT }, () => Array<number>(4).fill(0));
  const lastSeen = Array<number>(DIGIT_COUNT).fill(-1);
  const first = digits[0];
  if (isDigit(first)) lastSeen[first] = 0;

  for (let outcomeIndex = 1; outcomeIndex < digits.length; outcomeIndex++) {
    const outcome = digits[outcomeIndex];
    if (!isDigit(outcome)) continue;
    for (let digit = 0; digit < DIGIT_COUNT; digit++) {
      const age = outcomeIndex - 1 - (lastSeen[digit] ?? -1);
      const bucket = absenceAgeBucket(age);
      samples[digit]![bucket] = (samples[digit]?.[bucket] ?? 0) + 1;
      if (outcome === digit) successes[digit]![bucket] = (successes[digit]?.[bucket] ?? 0) + 1;
    }
    lastSeen[outcome] = outcomeIndex;
  }

  const rawRates: number[] = [];
  for (let digit = 0; digit < DIGIT_COUNT; digit++) {
    const age = digits.length - 1 - (lastSeen[digit] ?? -1);
    const bucket = absenceAgeBucket(age);
    const sampleCount = samples[digit]?.[bucket] ?? 0;
    if (sampleCount < minimumSamples) return null;
    const baseRate = prior[digit] ?? 0.1;
    rawRates.push(((successes[digit]?.[bucket] ?? 0) + 10 * baseRate) / (sampleCount + 10));
  }
  const total = rawRates.reduce((sum, value) => sum + value, 0);
  return total > 0 ? rawRates.map((value) => value / total) : prior;
}

function expertDistributions(
  settings: ResearchSettings,
  getSummary: (window: ResearchWindow) => WindowStatistics,
): Partial<Record<EnsembleExpertId, number[]>> {
  const experts: Partial<Record<EnsembleExpertId, number[]>> = {};
  for (const id of ["rolling_frequency", "mad", "least_appearing"] as const) {
    const config = settings[id];
    if (!config.enabled) continue;
    const summary = getSummary(config.window);
    if (summary.digits.length < config.window || summary.digits.length === 0) continue;
    const total = summary.counts.reduce((sum, count) => sum + count, 0);
    if (id === "least_appearing") {
      const highest = Math.max(...summary.counts);
      const inverse = summary.counts.map((count) => highest - count + 1);
      const inverseTotal = inverse.reduce((sum, count) => sum + count, 0);
      experts[id] = inverse.map((count) => count / inverseTotal);
    } else {
      experts[id] = smoothedDistribution(summary.counts, total, summary.prior);
    }
  }
  const streakConfig = settings.multi_model_agreement;
  if (streakConfig.enabled) {
    const streakSummary = getSummary(streakConfig.window);
    if (streakSummary.digits.length >= streakConfig.window) {
      const distribution = streakContextDistribution(
        streakSummary.digits,
        streakSummary.prior,
        streakConfig.minimumSamples,
      );
      if (distribution) experts.streak_context = distribution;
    }
  }
  const transition = contextFromSummary(
    getSummary(settings.transition_matrix.window),
    settings.transition_matrix,
    1,
  );
  const markovSummary = getSummary(settings.markov_chain.window);
  const markovFirst = contextFromSummary(markovSummary, settings.markov_chain, 1);
  const markovSecond = contextFromSummary(markovSummary, settings.markov_chain, 2);
  const pair = contextFromSummary(
    getSummary(settings.two_digit_sequence.window),
    settings.two_digit_sequence,
    2,
  );
  const triple = contextFromSummary(
    getSummary(settings.three_digit_sequence.window),
    settings.three_digit_sequence,
    3,
  );
  const conditionalSummary = getSummary(settings.conditional_probability.window);
  const conditional3 = contextFromSummary(conditionalSummary, settings.conditional_probability, 3);
  const conditional2 = contextFromSummary(conditionalSummary, settings.conditional_probability, 2);
  const conditional1 = contextFromSummary(conditionalSummary, settings.conditional_probability, 1);
  if (transition) experts.transition_matrix = transition.probabilities;
  if (markovFirst) experts.markov_first = markovFirst.probabilities;
  if (markovSecond) experts.markov_second = markovSecond.probabilities;
  if (pair) experts.two_digit_sequence = pair.probabilities;
  if (triple) experts.three_digit_sequence = triple.probabilities;
  const conditional = conditional3 ?? conditional2 ?? conditional1;
  if (conditional) experts.conditional_probability = conditional.probabilities;
  return experts;
}

function snapshotForHistory(history: number[], settings: ResearchSettings): ResearchSnapshot {
  const summaries = new Map<ResearchWindow, WindowStatistics>();
  const getSummary = (window: ResearchWindow) => {
    let summary = summaries.get(window);
    if (!summary) {
      summary = summarizeWindow(history.slice(-window));
      summaries.set(window, summary);
    }
    return summary;
  };
  const candidates = {} as Record<ResearchStrategyId, SnapshotCandidate>;
  for (const id of RESEARCH_STRATEGIES) {
    const config = settings[id];
    const output = outputForStrategy(id, config, getSummary(config.window), null);
    candidates[id] = {
      digit: output.targetDigit,
      probability: output.estimatedProbability,
      diagnosticDigit: output.rankedDigits[0] ?? null,
    };
  }
  return { candidates, experts: expertDistributions(settings, getSummary) };
}

function performanceFor(
  snapshots: ResearchSnapshot[],
  outcomes: number[],
  id: ResearchStrategyId,
  diagnostic = false,
): SegmentPerformance {
  let predictions = 0;
  let correct = 0;
  let currentLosses = 0;
  let maxLosingStreak = 0;
  snapshots.forEach((snapshot, index) => {
    const candidate = snapshot.candidates[id];
    const digit = diagnostic ? candidate?.diagnosticDigit : candidate?.digit;
    const outcome = outcomes[index];
    if (!isDigit(digit) || !isDigit(outcome)) return;
    predictions++;
    if (digit === outcome) {
      correct++;
      currentLosses = 0;
    } else {
      currentLosses++;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosses);
    }
  });
  const interval = wilsonInterval(correct, predictions);
  const pValue = binomialUpperTailPValue(correct, predictions);
  return {
    predictions,
    correct,
    incorrect: predictions - correct,
    accuracy: predictions ? correct / predictions : null,
    interval,
    pValue,
    adjustedPValue: adjustedPValue(pValue),
    maxLosingStreak,
    maxDrawdownStakes: null,
  };
}

function ensemblePerformanceFor(
  snapshots: ResearchSnapshot[],
  outcomes: number[],
  settings: ResearchStrategySettings,
  weights: Partial<Record<EnsembleExpertId, number>>,
): SegmentPerformance {
  let predictions = 0;
  let correct = 0;
  let currentLosses = 0;
  let maxLosingStreak = 0;
  snapshots.forEach((snapshot, index) => {
    if (!settings.enabled) return;
    const distribution = weightedDistribution(weights, snapshot.experts);
    if (!distribution) return;
    const automaticDigit = mostLikely(distribution);
    const digit = settings.target === "auto" ? automaticDigit : settings.target;
    const probability = digit === null ? 0 : (distribution[digit] ?? 0);
    const outcome = outcomes[index];
    if (!isDigit(digit) || !isDigit(outcome) || probability < settings.minimumConfidence / 100)
      return;
    predictions++;
    if (digit === outcome) {
      correct++;
      currentLosses = 0;
    } else {
      currentLosses++;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosses);
    }
  });
  const interval = wilsonInterval(correct, predictions);
  const pValue = binomialUpperTailPValue(correct, predictions);
  return {
    predictions,
    correct,
    incorrect: predictions - correct,
    accuracy: predictions ? correct / predictions : null,
    interval,
    pValue,
    adjustedPValue: adjustedPValue(pValue),
    maxLosingStreak,
    maxDrawdownStakes: null,
  };
}

function segmentPredictions(
  snapshots: ResearchSnapshot[],
  outcomes: number[],
  start: number,
  end: number,
): { snapshots: ResearchSnapshot[]; outcomes: number[] } {
  return { snapshots: snapshots.slice(start, end), outcomes: outcomes.slice(start, end) };
}

function modelStatus(
  id: ResearchStrategyId,
  validation: SegmentPerformance,
  finalTest: SegmentPerformance,
  minimumConfidence: number,
): ResearchModuleValidation["status"] {
  if (DESCRIPTIVE_IDS.includes(id)) return "descriptive";
  if (
    validation.predictions < MINIMUM_VALIDATION_PREDICTIONS ||
    finalTest.predictions < MINIMUM_VALIDATION_PREDICTIONS
  )
    return "insufficient data";
  const threshold = Math.max(RANDOM_BASELINE, minimumConfidence / 100);
  return (validation.interval?.lower ?? 0) > threshold &&
    (finalTest.interval?.lower ?? 0) > threshold &&
    (validation.adjustedPValue ?? 1) < 0.05 &&
    (finalTest.adjustedPValue ?? 1) < 0.05
    ? "validated"
    : "not validated";
}

function emptyPerformance(): SegmentPerformance {
  return {
    predictions: 0,
    correct: 0,
    incorrect: 0,
    accuracy: null,
    interval: null,
    pValue: null,
    adjustedPValue: null,
    maxLosingStreak: 0,
    maxDrawdownStakes: null,
  };
}

/**
 * Chronological 60/20/20 evaluation. Every prediction is built only from earlier
 * digits; ensemble weights are fitted on the 60% development period and frozen
 * before validation and final testing.
 */
export function runResearchBacktest(
  inputDigits: number[],
  settings: ResearchSettings,
): DigitResearchBacktest {
  const digits = validDigits(inputDigits);
  const developmentEnd = Math.floor(digits.length * 0.6);
  const validationEnd = Math.floor(digits.length * 0.8);
  const snapshots: ResearchSnapshot[] = Array.from({ length: digits.length }, () => ({
    candidates: Object.fromEntries(
      RESEARCH_STRATEGIES.map((id) => [
        id,
        { digit: null, probability: null, diagnosticDigit: null },
      ]),
    ) as Record<ResearchStrategyId, SnapshotCandidate>,
    experts: {},
  }));
  for (let outcomeIndex = 1; outcomeIndex < digits.length; outcomeIndex++) {
    snapshots[outcomeIndex] = snapshotForHistory(digits.slice(0, outcomeIndex), settings);
  }

  const developmentExamples: EnsembleTrainingExample[] = [];
  for (let index = 1; index < developmentEnd; index++) {
    const targetDigit = digits[index];
    if (!isDigit(targetDigit)) continue;
    developmentExamples.push({ targetDigit, distributions: snapshots[index]?.experts ?? {} });
  }
  const weights = trainModelAgreementWeights(developmentExamples);
  const development = segmentPredictions(snapshots, digits, 0, developmentEnd);
  const validation = segmentPredictions(snapshots, digits, developmentEnd, validationEnd);
  const finalTest = segmentPredictions(snapshots, digits, validationEnd, digits.length);
  const models: ResearchModuleValidation[] = RESEARCH_STRATEGIES.filter(
    (id) => id !== "multi_model_agreement" && id !== "edge_validation",
  ).map((id) => {
    const diagnosticOnly = DESCRIPTIVE_IDS.includes(id);
    const developmentMetrics = performanceFor(
      development.snapshots,
      development.outcomes,
      id,
      diagnosticOnly,
    );
    const validationMetrics = performanceFor(
      validation.snapshots,
      validation.outcomes,
      id,
      diagnosticOnly,
    );
    const finalMetrics = performanceFor(
      finalTest.snapshots,
      finalTest.outcomes,
      id,
      diagnosticOnly,
    );
    const status = modelStatus(id, validationMetrics, finalMetrics, settings[id].minimumConfidence);
    return {
      id,
      descriptiveOnly: diagnosticOnly,
      development: developmentMetrics,
      validation: validationMetrics,
      finalTest: finalMetrics,
      status,
      expectedValue: null,
      liveEligible: false as const,
      reason: diagnosticOnly
        ? "Descriptive diagnostics only; this ranking is not eligible for a trading signal."
        : status === "validated"
          ? "Predictive performance passed both holdout periods. Live trading still needs a current proposal, positive expected value, and risk approval."
          : status === "insufficient data"
            ? `Need at least ${MINIMUM_VALIDATION_PREDICTIONS} scored predictions in both the validation and final-test periods.`
            : "The model has not shown a statistically significant, multiple-test-adjusted edge across both holdout periods.",
    } satisfies ResearchModuleValidation;
  });

  const addEnsemble = (
    name: "development" | "validation" | "finalTest",
    range: { snapshots: ResearchSnapshot[]; outcomes: number[] },
  ) =>
    ensemblePerformanceFor(
      range.snapshots,
      range.outcomes,
      settings.multi_model_agreement,
      weights,
    );
  const developmentEnsemble = addEnsemble("development", development);
  const validationEnsemble = addEnsemble("validation", validation);
  const finalEnsemble = addEnsemble("finalTest", finalTest);
  const ensembleStatus = modelStatus(
    "multi_model_agreement",
    validationEnsemble,
    finalEnsemble,
    settings.multi_model_agreement.minimumConfidence,
  );
  models.push({
    id: "multi_model_agreement",
    descriptiveOnly: false,
    development: developmentEnsemble,
    validation: validationEnsemble,
    finalTest: finalEnsemble,
    status: ensembleStatus,
    expectedValue: null,
    liveEligible: false,
    reason:
      ensembleStatus === "validated"
        ? "Development-trained weights passed both holdout periods. Live trading still requires a current positive-EV proposal and risk approval."
        : "Weights were fitted only on development predictions; the combined model has not passed both corrected holdout checks.",
  });
  models.push({
    id: "edge_validation",
    descriptiveOnly: false,
    development: emptyPerformance(),
    validation: emptyPerformance(),
    finalTest: emptyPerformance(),
    status: models.some((model) => model.status === "validated") ? "validated" : "not validated",
    expectedValue: null,
    liveEligible: false,
    reason: `Validation uses chronological holdouts, Wilson intervals, exact binomial tests, and Bonferroni adjustment across ${MULTIPLE_TEST_FAMILY_SIZE.toLocaleString()} predeclared market/window/module/digit comparisons. Payout-adjusted expected value needs historical contract quotes and is not inferred from ticks.`,
  });

  const frequencyBaseline = performanceFor(
    finalTest.snapshots,
    finalTest.outcomes,
    "rolling_frequency",
    true,
  );
  const liveTradingStatus = models.some((model) => model.status === "validated")
    ? "No live trades are enabled. Statistical validation does not establish profitability; an actual Deriv proposal and a positive expected value above the safety margin are still required."
    : "No strategy has passed the corrected holdout checks. Research and observation only; live execution is unavailable.";

  return {
    totalTicks: digits.length,
    evaluatedTicks: Math.max(0, digits.length - 1),
    development: {
      startIndex: 0,
      endIndex: developmentEnd,
      performance: developmentEnd ? (developmentEnd / Math.max(1, digits.length)) * 100 : 0,
    },
    validation: {
      startIndex: developmentEnd,
      endIndex: validationEnd,
      performance:
        validationEnd > developmentEnd
          ? ((validationEnd - developmentEnd) / Math.max(1, digits.length)) * 100
          : 0,
    },
    finalTest: {
      startIndex: validationEnd,
      endIndex: digits.length,
      performance:
        digits.length > validationEnd
          ? ((digits.length - validationEnd) / Math.max(1, digits.length)) * 100
          : 0,
    },
    randomBaseline: RANDOM_BASELINE,
    frequencyBaseline,
    models,
    ensembleWeights: weights,
    walkForward: true,
    lookAheadBias: false,
    payoutAdjustedExpectedValue: null,
    liveTradingStatus,
  };
}

export function analyzeResearchHistory(
  inputDigits: number[],
  settings: ResearchSettings,
  weights: Partial<Record<EnsembleExpertId, number>> | null = null,
): DigitResearchAnalysis {
  const digits = validDigits(inputDigits);
  const configuredWindow = Math.max(
    ...RESEARCH_STRATEGIES.map((id) => settings[id].window),
  ) as ResearchWindow;
  const enabledWindows = RESEARCH_STRATEGIES.filter((id) => settings[id].enabled).map(
    (id) => settings[id].window,
  );
  const selectedWindow = Math.max(
    ...(enabledWindows.length ? enabledWindows : [configuredWindow]),
  ) as ResearchWindow;
  const windowDigits = digits.slice(-selectedWindow);
  const summary = summarizeWindow(windowDigits);
  const frequencies = frequencyRows(windowDigits);
  const frequencyRanking = [...frequencies].sort((a, b) => b.count - a.count || a.digit - b.digit);
  const lowRanking = [...frequencies].sort((a, b) => a.count - b.count || a.digit - b.digit);
  const markovSummary = summarizeWindow(digits.slice(-settings.markov_chain.window));
  const markovLastDigit = markovSummary.digits.at(-1);
  const rowCounts = isDigit(markovLastDigit)
    ? (markovSummary.transitionCounts[markovLastDigit] ?? emptyCounts())
    : emptyCounts();
  const rowSamples = isDigit(markovLastDigit)
    ? (markovSummary.transitionSamples[markovLastDigit] ?? 0)
    : 0;
  const first = contextAnalysis(
    1,
    String(markovLastDigit ?? ""),
    rowCounts,
    rowSamples,
    markovSummary.prior,
    settings.markov_chain.minimumSamples,
  );
  const lastPairWindow = digits.slice(-settings.two_digit_sequence.window);
  const pairSummary = summarizeWindow(lastPairWindow);
  const lastPair = lastPairWindow.slice(-2).join("");
  const pairCounts = pairSummary.pairFollowers.get(lastPair) ?? emptyCounts();
  const pairSamples = pairCounts.reduce((sum, count) => sum + count, 0);
  const markovPair = markovSummary.digits.slice(-2).join("");
  const markovPairCounts = markovSummary.pairFollowers.get(markovPair) ?? emptyCounts();
  const markovPairSamples = markovPairCounts.reduce((sum, count) => sum + count, 0);
  const second = contextAnalysis(
    2,
    markovPair,
    markovPairCounts,
    markovPairSamples,
    markovSummary.prior,
    settings.markov_chain.minimumSamples,
  );
  const tripleWindow = digits.slice(-settings.three_digit_sequence.window);
  const tripleSummary = summarizeWindow(tripleWindow);
  const triple = tripleWindow.slice(-3).join("");
  const tripleCounts = tripleSummary.tripleFollowers.get(triple) ?? emptyCounts();
  const tripleSamples = tripleCounts.reduce((sum, count) => sum + count, 0);
  const third = contextAnalysis(
    3,
    triple,
    tripleCounts,
    tripleSamples,
    tripleSummary.prior,
    settings.three_digit_sequence.minimumSamples,
  );
  const matrix = buildDigitTransitionMatrix(windowDigits);
  let currentRunLength = 0;
  const currentRunDigit = windowDigits.at(-1) ?? null;
  if (currentRunDigit !== null) {
    for (
      let index = windowDigits.length - 1;
      index >= 0 && windowDigits[index] === currentRunDigit;
      index--
    )
      currentRunLength++;
  }
  const summaryCache = new Map<ResearchWindow, WindowStatistics>();
  const getSummary = (window: ResearchWindow) => {
    let cached = summaryCache.get(window);
    if (!cached) {
      cached = summarizeWindow(digits.slice(-window));
      summaryCache.set(window, cached);
    }
    return cached;
  };
  const ensembleExperts = expertDistributions(settings, getSummary);
  const ensembleProbability = weights ? weightedDistribution(weights, ensembleExperts) : null;
  const transitionContext = contextFromSummary(
    getSummary(settings.transition_matrix.window),
    settings.transition_matrix,
    1,
  );
  const markovContext1 = contextFromSummary(
    getSummary(settings.markov_chain.window),
    settings.markov_chain,
    1,
  );
  const markovContext2 = contextFromSummary(
    getSummary(settings.markov_chain.window),
    settings.markov_chain,
    2,
  );
  const pairContext = contextFromSummary(
    getSummary(settings.two_digit_sequence.window),
    settings.two_digit_sequence,
    2,
  );
  const tripleContext = contextFromSummary(
    getSummary(settings.three_digit_sequence.window),
    settings.three_digit_sequence,
    3,
  );
  const conditional3 = contextFromSummary(
    getSummary(settings.conditional_probability.window),
    settings.conditional_probability,
    3,
  );
  const conditional2 = contextFromSummary(
    getSummary(settings.conditional_probability.window),
    settings.conditional_probability,
    2,
  );
  const conditional1 = contextFromSummary(
    getSummary(settings.conditional_probability.window),
    settings.conditional_probability,
    1,
  );
  const conditionalContext = conditional3 ?? conditional2 ?? conditional1;
  const ensembleContextSamples = [
    transitionContext,
    markovContext1,
    markovContext2,
    pairContext,
    tripleContext,
    conditionalContext,
  ]
    .map((context) => context?.samples ?? 0)
    .filter((samples) => samples > 0)
    .reduce((minimum, samples) => Math.min(minimum, samples), Number.POSITIVE_INFINITY);
  const ensembleOverride = {
    probabilities: ensembleProbability,
    contextSamples: Number.isFinite(ensembleContextSamples) ? ensembleContextSamples : 0,
    experts: ensembleExperts,
  };
  const modules = RESEARCH_STRATEGIES.map((id) =>
    outputForStrategy(
      id,
      settings[id],
      getSummary(settings[id].window),
      weights,
      id === "multi_model_agreement" ? ensembleOverride : undefined,
    ),
  );
  const markovReady =
    settings.markov_chain.enabled && markovSummary.digits.length >= settings.markov_chain.window;
  const pairReady =
    settings.two_digit_sequence.enabled &&
    pairSummary.digits.length >= settings.two_digit_sequence.window;
  const tripleReady =
    settings.three_digit_sequence.enabled &&
    tripleSummary.digits.length >= settings.three_digit_sequence.window;
  const gatedFirst = markovReady ? first : { ...first, predictedDigit: null };
  const gatedSecond = markovReady ? second : { ...second, predictedDigit: null };
  const gatedPair = pairReady
    ? contextAnalysis(
        2,
        lastPair,
        pairCounts,
        pairSamples,
        summary.prior,
        settings.two_digit_sequence.minimumSamples,
      )
    : {
        ...contextAnalysis(
          2,
          lastPair,
          pairCounts,
          pairSamples,
          pairSummary.prior,
          settings.two_digit_sequence.minimumSamples,
        ),
        predictedDigit: null,
      };
  const gatedThird = tripleReady ? third : { ...third, predictedDigit: null };

  return {
    marketScope: "one market only",
    requestedWindow: selectedWindow,
    sampleSize: Math.min(digits.length, selectedWindow),
    ready: digits.length >= selectedWindow,
    frequencies: frequencyRows(digits.slice(-selectedWindow)),
    frequencyRanking: [...frequencyRows(digits.slice(-selectedWindow))].sort(
      (a, b) => b.count - a.count || a.digit - b.digit,
    ),
    mostAppearing: frequencyRanking.slice(0, 3),
    leastAppearing: lowRanking.slice(0, 3),
    frequencyChanges: frequenciesByWindow(windowDigits),
    absenceStreaks: absenceStreaks(windowDigits),
    currentRunDigit,
    currentRunLength,
    transitionMatrix: matrix,
    markovOrder1: gatedFirst,
    markovOrder2: gatedSecond,
    sequenceOrder2: gatedPair,
    sequenceOrder3: gatedThird,
    activeSequence:
      gatedThird.predictedDigit !== null
        ? gatedThird
        : gatedPair.predictedDigit !== null
          ? gatedPair
          : gatedSecond.predictedDigit !== null
            ? gatedSecond
            : gatedFirst.predictedDigit !== null
              ? gatedFirst
              : null,
    modules,
    ensembleWeights: weights,
    signalEligible: false,
    liveTradingStatus:
      "Live trading is locked. Tick history does not include contract payouts; enablement requires untouched holdout validation, a current Deriv proposal with positive expected value, and risk approval.",
  };
}

/** Trains a convex probability mixture by minimizing development-set log loss. */
export function trainModelAgreementWeights(
  examples: EnsembleTrainingExample[],
): Record<EnsembleExpertId, number> {
  const usable = examples.filter(
    (example) =>
      isDigit(example.targetDigit) &&
      ENSEMBLE_EXPERTS.some((id) => validProbabilityVector(example.distributions[id])),
  );
  const initial = 1 / ENSEMBLE_EXPERTS.length;
  let weights = ENSEMBLE_EXPERTS.map(() => initial);
  if (!usable.length)
    return Object.fromEntries(
      ENSEMBLE_EXPERTS.map((id, index) => [id, weights[index] ?? 0]),
    ) as Record<EnsembleExpertId, number>;

  const learningRate = 0.08;
  const regularization = 0.002;
  for (let iteration = 0; iteration < 240; iteration++) {
    const gradient = Array<number>(ENSEMBLE_EXPERTS.length).fill(0);
    let included = 0;
    for (const example of usable) {
      const active = ENSEMBLE_EXPERTS.map((id, index) => ({
        id,
        index,
        probabilities: example.distributions[id],
      })).filter((entry) => validProbabilityVector(entry.probabilities));
      const weightTotal = active.reduce((sum, entry) => sum + (weights[entry.index] ?? 0), 0);
      if (!active.length || weightTotal <= 0) continue;
      const targetProbability = active.reduce(
        (sum, entry) =>
          sum +
          ((weights[entry.index] ?? 0) / weightTotal) *
            (entry.probabilities?.[example.targetDigit] ?? 0),
        0,
      );
      if (targetProbability <= 0) continue;
      active.forEach((entry) => {
        const p = entry.probabilities?.[example.targetDigit] ?? 0;
        gradient[entry.index] = (gradient[entry.index] ?? 0) - p / targetProbability;
      });
      included++;
    }
    if (!included) break;
    const next = weights.map(
      (weight, index) =>
        weight -
        learningRate * ((gradient[index] ?? 0) / included + regularization * (weight - initial)),
    );
    weights = projectToSimplex(next);
  }

  return Object.fromEntries(
    ENSEMBLE_EXPERTS.map((id, index) => [id, weights[index] ?? 0]),
  ) as Record<EnsembleExpertId, number>;
}

function validProbabilityVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === DIGIT_COUNT &&
    value.every((item) => Number.isFinite(item) && item >= 0)
  );
}

function projectToSimplex(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => b - a);
  let cumulative = 0;
  let threshold = 0;
  for (let index = 0; index < sorted.length; index++) {
    cumulative += sorted[index] ?? 0;
    const candidate = (cumulative - 1) / (index + 1);
    if ((sorted[index] ?? 0) > candidate) threshold = candidate;
  }
  const projected = values.map((value) => Math.max(0, value - threshold));
  const sum = projected.reduce((total, value) => total + value, 0);
  return sum > 0 ? projected.map((value) => value / sum) : values.map(() => 1 / values.length);
}

export function assessDigitMatchTrade(
  input: DigitResearchTradeGateInput,
): DigitResearchTradeAssessment {
  const deny = (reason: string): DigitResearchTradeAssessment => ({
    eligible: false,
    reason,
    expectedValue: null,
    breakEvenProbability: null,
  });
  const numericInputs = [
    input.estimate,
    input.lowerConfidenceBound,
    input.minimumEstimate,
    input.stake,
    input.proposalAsk,
    input.proposalPayout,
    input.balance,
    input.dailyTrades,
    input.dailyLoss,
    input.consecutiveLosses,
    input.openContracts,
    input.testingBalance,
    input.maxDailyTrades ?? 20,
    input.maxDailyLossPercent ?? 3,
    input.maxConsecutiveLosses ?? 3,
    input.minimumExpectedValue ?? 0,
  ];
  if (!numericInputs.every(Number.isFinite))
    return deny("The live risk inputs are incomplete or invalid.");
  if (
    input.estimate < 0 ||
    input.estimate > 1 ||
    input.lowerConfidenceBound < 0 ||
    input.lowerConfidenceBound > 1 ||
    input.minimumEstimate < 0 ||
    input.minimumEstimate > 1
  )
    return deny("The model confidence values must be between 0% and 100%.");
  if (!input.validated)
    return deny("The strategy has not passed validation and untouched final testing.");
  if (input.lowerConfidenceBound <= RANDOM_BASELINE)
    return deny("The final-test confidence bound does not exceed the 10% baseline.");
  if (input.estimate < input.minimumEstimate)
    return deny("The validated estimate is below the configured confidence threshold.");
  if (input.openContracts >= 1) return deny("A contract is already open.");
  if (input.dailyTrades >= (input.maxDailyTrades ?? 20))
    return deny("The daily trade limit has been reached.");
  const maxDailyLossPercent = Math.max(0.1, Math.min(3, input.maxDailyLossPercent ?? 3));
  const dailyLossLimit = input.testingBalance * (maxDailyLossPercent / 100);
  if (input.dailyLoss >= dailyLossLimit)
    return deny(`The ${maxDailyLossPercent}% daily loss limit has been reached.`);
  if (input.consecutiveLosses >= (input.maxConsecutiveLosses ?? 3))
    return deny("The consecutive-loss stop requires a manual restart.");
  if (input.stake <= 0 || input.proposalAsk <= 0 || input.proposalPayout <= input.proposalAsk)
    return deny("A current, valid Deriv Digit Match proposal is required.");
  if (Math.abs(input.stake - input.proposalAsk) > 0.005)
    return deny("The proposal stake does not match the configured stake.");
  if (input.testingBalance <= 0)
    return deny("A valid starting balance is required to enforce the daily loss limit.");
  if (input.dailyLoss + input.proposalAsk > dailyLossLimit + 0.000001)
    return deny("The next stake could exceed the remaining daily loss allowance.");
  if (input.balance < input.proposalAsk)
    return deny("The account balance is below the proposed stake.");
  const netProfit = input.proposalPayout - input.proposalAsk;
  const conservativeProbability = input.lowerConfidenceBound;
  const expectedValue =
    conservativeProbability * netProfit - (1 - conservativeProbability) * input.proposalAsk;
  const breakEvenProbability = input.proposalAsk / input.proposalPayout;
  if (expectedValue < (input.minimumExpectedValue ?? 0)) {
    return {
      eligible: false,
      reason: "Expected value does not clear the configured safety margin.",
      expectedValue,
      breakEvenProbability,
    };
  }
  return {
    eligible: true,
    reason: "Validated estimate and current proposal pass the risk checks.",
    expectedValue,
    breakEvenProbability,
  };
}
