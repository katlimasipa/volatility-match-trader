export type StepMatchDirection = "above" | "below";

export interface StepMatchConfig {
  zeroToFour: StepMatchDirection;
  fiveToNine: StepMatchDirection;
}

export interface StepMatchBacktestResult {
  totalTicks: number;
  signals: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  baselineAccuracy: number;
}

/**
 * Map the current tick digit to its adjacent target, wrapping around 0–9.
 * Digits 0–4 use the first configured direction; digits 5–9 use the second.
 */
export function getStepMatchTarget(entryDigit: number, config: StepMatchConfig): number | null {
  if (!Number.isInteger(entryDigit) || entryDigit < 0 || entryDigit > 9) return null;
  const direction = entryDigit <= 4 ? config.zeroToFour : config.fiveToNine;
  return direction === "above" ? (entryDigit + 1) % 10 : (entryDigit + 9) % 10;
}

/**
 * Replay each source digit against the immediately following, unseen tick.
 * Every source digit is eligible because the two configured bands cover 0–9.
 */
export function backtestStepMatch(
  inputDigits: number[],
  config: StepMatchConfig,
): StepMatchBacktestResult {
  const digits = inputDigits.filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
  let correct = 0;
  let signals = 0;

  for (let index = 0; index < digits.length - 1; index++) {
    const entryDigit = digits[index];
    const outcomeDigit = digits[index + 1];
    if (entryDigit === undefined || outcomeDigit === undefined) continue;
    const targetDigit = getStepMatchTarget(entryDigit, config);
    if (targetDigit === null) continue;
    signals++;
    if (outcomeDigit === targetDigit) correct++;
  }

  const incorrect = signals - correct;
  return {
    totalTicks: digits.length,
    signals,
    correct,
    incorrect,
    accuracy: signals > 0 ? (correct / signals) * 100 : 0,
    baselineAccuracy: 10,
  };
}
