export const DIGIT_INTELLIGENCE_WINDOWS = [50, 100, 250, 500] as const;
export type DigitIntelligenceWindow = (typeof DIGIT_INTELLIGENCE_WINDOWS)[number];
export type DigitTargetSelection = "auto" | number;

export interface DigitIntelligenceSettings {
  window: DigitIntelligenceWindow;
  minimumConfidence: number;
  minimumSequenceSamples: number;
  target: DigitTargetSelection;
}

export interface DigitFrequency {
  digit: number;
  count: number;
  percentage: number;
  expectedCount: number;
  deviation: number;
  representation: "over" | "under" | "average";
}

export interface SequenceSummary {
  pattern: string;
  samples: number;
  nextDigit: number;
  nextCount: number;
  nextPercentage: number;
}

export interface ActiveSequence {
  pattern: string;
  length: number;
  samples: number;
  nextDigitCounts: number[];
}

export interface DigitIntelligenceAnalysis {
  requestedWindow: DigitIntelligenceWindow;
  sampleSize: number;
  ready: boolean;
  frequencies: DigitFrequency[];
  absenceStreaks: number[];
  currentRunDigit: number | null;
  currentRunLength: number;
  recurringSequences: SequenceSummary[];
  activeSequence: ActiveSequence | null;
  targetDigit: number | null;
  confidence: number | null;
  confidenceMeaning: "model agreement and evidence support, not win probability";
  modelProbabilities: {
    frequency: number[];
    streak: number[];
    sequence: number[];
    combined: number[];
  };
  modelLeaders: {
    frequency: number | null;
    streak: number | null;
    sequence: number | null;
  };
  signalReady: boolean;
  reason: string;
}

export interface DigitIntelligenceBacktest {
  totalTicks: number;
  evaluatedTicks: number;
  signals: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  baselineAccuracy: number;
  frequencyBaselineAccuracy: number;
  coverage: number;
  averageConfidence: number;
}

const DIGIT_COUNT = 10;
const FREQUENCY_WEIGHT = 0.35;
const STREAK_WEIGHT = 0.25;
const SEQUENCE_WEIGHT = 0.4;
const SMOOTHING_PRIOR = 10;

function isDigit(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value < DIGIT_COUNT;
}

function absenceBucket(streak: number): number {
  if (streak <= 0) return 0;
  if (streak === 1) return 1;
  if (streak <= 3) return 2;
  if (streak <= 7) return 3;
  return 4;
}

function mostCommonDigit(counts: number[]): number {
  let best = 0;
  for (let digit = 1; digit < DIGIT_COUNT; digit++) {
    if ((counts[digit] ?? 0) > (counts[best] ?? 0)) best = digit;
  }
  return best;
}

function countFollowers(digits: number[], patternLength: number): Map<string, number[]> {
  const followers = new Map<string, number[]>();
  for (let nextIndex = patternLength; nextIndex < digits.length; nextIndex++) {
    const pattern = digits.slice(nextIndex - patternLength, nextIndex).join("");
    const nextDigit = digits[nextIndex];
    if (!isDigit(nextDigit)) continue;
    const counts = followers.get(pattern) ?? Array(DIGIT_COUNT).fill(0);
    counts[nextDigit] = (counts[nextDigit] ?? 0) + 1;
    followers.set(pattern, counts);
  }
  return followers;
}

function currentAbsenceStreaks(digits: number[]): number[] {
  const lastSeen = Array<number>(DIGIT_COUNT).fill(-1);
  digits.forEach((digit, index) => {
    if (isDigit(digit)) lastSeen[digit] = index;
  });
  return lastSeen.map((index) => (index < 0 ? digits.length : digits.length - index - 1));
}

function scoreFromCounts(counts: number[], prior: number[]): number[] {
  const sampleSize = counts.reduce((sum, count) => sum + count, 0);
  const priorSize = prior.reduce((sum, probability) => sum + probability, 0);
  return counts.map(
    (count, digit) => (count + priorSize * (prior[digit] ?? 0)) / (sampleSize + priorSize),
  );
}

/**
 * Computes rolling frequency, absence/run streak, and sequence-following evidence.
 * The caller should pass only ticks available before the tick being forecast.
 */
export function analyzeDigitIntelligence(
  inputDigits: number[],
  settings: DigitIntelligenceSettings,
): DigitIntelligenceAnalysis {
  const digits = inputDigits.filter(isDigit).slice(-settings.window);
  const sampleSize = digits.length;
  const counts = Array<number>(DIGIT_COUNT).fill(0);
  digits.forEach((digit) => {
    counts[digit] = (counts[digit] ?? 0) + 1;
  });
  const expectedCount = sampleSize / DIGIT_COUNT;
  const baselineProbabilities = counts.map((count) => (count + 1) / (sampleSize + DIGIT_COUNT));
  const frequencies = counts.map((count, digit): DigitFrequency => {
    const deviation = count - expectedCount;
    return {
      digit,
      count,
      percentage: sampleSize > 0 ? (count / sampleSize) * 100 : 0,
      expectedCount,
      deviation,
      representation: Math.abs(deviation) < 1e-9 ? "average" : deviation > 0 ? "over" : "under",
    };
  });

  const absenceStreaks = currentAbsenceStreaks(digits);
  const currentRunDigit = digits.at(-1) ?? null;
  let currentRunLength = 0;
  if (currentRunDigit !== null) {
    for (let index = digits.length - 1; index >= 0 && digits[index] === currentRunDigit; index--) {
      currentRunLength++;
    }
  }

  const streakSamples = Array.from({ length: DIGIT_COUNT }, () => Array(5).fill(0));
  const streakHits = Array.from({ length: DIGIT_COUNT }, () => Array(5).fill(0));
  const lastSeen = Array<number>(DIGIT_COUNT).fill(-1);
  for (let outcomeIndex = 1; outcomeIndex < digits.length; outcomeIndex++) {
    const outcome = digits[outcomeIndex];
    if (!isDigit(outcome)) continue;
    for (let digit = 0; digit < DIGIT_COUNT; digit++) {
      const digitLastSeen = lastSeen[digit] ?? -1;
      const gap = digitLastSeen < 0 ? outcomeIndex : outcomeIndex - 1 - digitLastSeen;
      const bucket = absenceBucket(gap);
      const samplesForDigit = streakSamples[digit];
      const hitsForDigit = streakHits[digit];
      if (!samplesForDigit || !hitsForDigit) continue;
      samplesForDigit[bucket] = (samplesForDigit[bucket] ?? 0) + 1;
      if (outcome === digit) hitsForDigit[bucket] = (hitsForDigit[bucket] ?? 0) + 1;
    }
    lastSeen[outcome] = outcomeIndex;
  }

  const pairFollowers = countFollowers(digits, 2);
  const singleFollowers = countFollowers(digits, 1);
  const trailingPair = digits.slice(-2).join("");
  const trailingSingle = digits.slice(-1).join("");
  const pairCounts = pairFollowers.get(trailingPair) ?? Array(DIGIT_COUNT).fill(0);
  const singleCounts = singleFollowers.get(trailingSingle) ?? Array(DIGIT_COUNT).fill(0);
  const pairSamples = pairCounts.reduce((sum, count) => sum + count, 0);
  const singleSamples = singleCounts.reduce((sum, count) => sum + count, 0);
  const activeSequence =
    pairSamples >= settings.minimumSequenceSamples
      ? { pattern: trailingPair, length: 2, samples: pairSamples, nextDigitCounts: pairCounts }
      : singleSamples >= settings.minimumSequenceSamples
        ? {
            pattern: trailingSingle,
            length: 1,
            samples: singleSamples,
            nextDigitCounts: singleCounts,
          }
        : null;

  const recurringSequences = [...pairFollowers.entries()]
    .map(([pattern, nextDigitCounts]) => {
      const samples = nextDigitCounts.reduce((sum, count) => sum + count, 0);
      const nextDigit = mostCommonDigit(nextDigitCounts);
      const nextCount = nextDigitCounts[nextDigit] ?? 0;
      return {
        pattern,
        samples,
        nextDigit,
        nextCount,
        nextPercentage: samples > 0 ? (nextCount / samples) * 100 : 0,
      };
    })
    .filter((sequence) => sequence.samples >= settings.minimumSequenceSamples)
    .sort(
      (a, b) =>
        b.samples - a.samples ||
        b.nextPercentage - a.nextPercentage ||
        a.pattern.localeCompare(b.pattern),
    )
    .slice(0, 8);

  const frequencyProbabilities = baselineProbabilities;
  const streakProbabilities = absenceStreaks.map((streak, digit) => {
    const bucket = absenceBucket(streak);
    const samples = streakSamples[digit]?.[bucket] ?? 0;
    const hits = streakHits[digit]?.[bucket] ?? 0;
    return (
      (hits + SMOOTHING_PRIOR * (baselineProbabilities[digit] ?? 0)) / (samples + SMOOTHING_PRIOR)
    );
  });
  const sequenceProbabilities = activeSequence
    ? scoreFromCounts(activeSequence.nextDigitCounts, baselineProbabilities)
    : Array(DIGIT_COUNT).fill(0);
  const combinedProbabilities = frequencyProbabilities.map(
    (probability, digit) =>
      FREQUENCY_WEIGHT * probability +
      STREAK_WEIGHT * (streakProbabilities[digit] ?? 0) +
      SEQUENCE_WEIGHT * (sequenceProbabilities[digit] ?? 0),
  );

  const enoughHistory = sampleSize >= settings.window;
  const signalReady = enoughHistory && activeSequence !== null;
  const frequencyLeader = enoughHistory ? mostCommonDigit(frequencyProbabilities) : null;
  const streakLeader = enoughHistory ? mostCommonDigit(streakProbabilities) : null;
  const sequenceLeader = activeSequence ? mostCommonDigit(sequenceProbabilities) : null;
  const modelLeaders = {
    frequency: frequencyLeader,
    streak: streakLeader,
    sequence: sequenceLeader,
  };
  const targetDigit = signalReady
    ? settings.target === "auto"
      ? mostCommonDigit(combinedProbabilities)
      : settings.target
    : null;
  const agreementWeight =
    targetDigit === null
      ? 0
      : (frequencyLeader === targetDigit ? FREQUENCY_WEIGHT : 0) +
        (streakLeader === targetDigit ? STREAK_WEIGHT : 0) +
        (sequenceLeader === targetDigit ? SEQUENCE_WEIGHT : 0);
  const evidenceSupport = activeSequence
    ? Math.min(1, activeSequence.samples / Math.max(1, settings.minimumSequenceSamples * 2))
    : 0;
  const confidence =
    targetDigit === null
      ? null
      : Math.max(0, Math.min(100, Math.round(70 * agreementWeight + 30 * evidenceSupport)));
  const passesConfidence = confidence !== null && confidence >= settings.minimumConfidence;
  const reason =
    sampleSize < settings.window
      ? `Collecting history (${sampleSize}/${settings.window} ticks).`
      : !activeSequence
        ? `The current trailing sequence has fewer than ${settings.minimumSequenceSamples} historical followers.`
        : !passesConfidence
          ? `Evidence score ${confidence}/100 is below the ${settings.minimumConfidence} minimum.`
          : `Signal ready: digit ${targetDigit} has an evidence score of ${confidence}/100.`;

  return {
    requestedWindow: settings.window,
    sampleSize,
    ready: enoughHistory,
    frequencies,
    absenceStreaks,
    currentRunDigit,
    currentRunLength,
    recurringSequences,
    activeSequence,
    targetDigit,
    confidence,
    confidenceMeaning: "model agreement and evidence support, not win probability",
    modelProbabilities: {
      frequency: frequencyProbabilities,
      streak: streakProbabilities,
      sequence: sequenceProbabilities,
      combined: combinedProbabilities,
    },
    modelLeaders,
    signalReady: signalReady && passesConfidence,
    reason,
  };
}

/**
 * Walk-forward validation: every forecast uses only preceding ticks and is scored
 * against the following, unseen tick. Accuracy is reported beside the 10% baseline.
 */
export function backtestDigitIntelligence(
  inputDigits: number[],
  settings: DigitIntelligenceSettings,
): DigitIntelligenceBacktest {
  const digits = inputDigits.filter(isDigit);
  let signals = 0;
  let correct = 0;
  let frequencyBaselineCorrect = 0;
  let confidenceTotal = 0;
  let evaluatedTicks = 0;

  for (let outcomeIndex = settings.window; outcomeIndex < digits.length; outcomeIndex++) {
    evaluatedTicks++;
    const history = digits.slice(outcomeIndex - settings.window, outcomeIndex);
    const analysis = analyzeDigitIntelligence(history, settings);
    if (!analysis.signalReady || analysis.targetDigit === null || analysis.confidence === null)
      continue;
    signals++;
    confidenceTotal += analysis.confidence;
    if (digits[outcomeIndex] === analysis.targetDigit) correct++;
    if (
      analysis.modelLeaders.frequency !== null &&
      digits[outcomeIndex] === analysis.modelLeaders.frequency
    ) {
      frequencyBaselineCorrect++;
    }
  }

  const incorrect = signals - correct;
  return {
    totalTicks: digits.length,
    evaluatedTicks,
    signals,
    correct,
    incorrect,
    accuracy: signals > 0 ? (correct / signals) * 100 : 0,
    baselineAccuracy: 10,
    frequencyBaselineAccuracy: signals > 0 ? (frequencyBaselineCorrect / signals) * 100 : 0,
    coverage: evaluatedTicks > 0 ? (signals / evaluatedTicks) * 100 : 0,
    averageConfidence: signals > 0 ? confidenceTotal / signals : 0,
  };
}
