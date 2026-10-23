export interface X2XQuoteDigit {
  digit: number;
  /** The quote's final two decimal places, kept as text (for example, "07"). */
  lastTwoQuoteDigits: string;
  quote?: number | undefined;
  tickId?: string | undefined;
  timestamp?: string | undefined;
}

export interface X2XScannerSignal {
  id: string;
  phase: "awaiting-ldp" | "awaiting-op";
  pattern: string;
  patternTickIds: string[];
  patternTickTimestamps: string[];
  patternQuotes: Array<number | null>;
  detectedAt: string;
  referencePair: string;
  opTrigger: string;
  ldp: number | null;
  eligibleTicksElapsed: number;
  eligibleTicksRemaining: number;
}

export interface X2XScannerState {
  /** One last digit per incoming tick, in chronological order. */
  recentDigits: number[];
  recentTickIds: string[];
  recentTimestamps: string[];
  recentQuotes: Array<number | null>;
  nextSignalSequence: number;
  signal: X2XScannerSignal | null;
}

export type X2XScannerEvent =
  | {
      type: "pattern";
      signalId: string;
      pattern: string;
      patternTickIds: string[];
      patternTickTimestamps: string[];
      patternQuotes: Array<number | null>;
      detectedAt: string;
      referencePair: string;
      opTrigger: string;
    }
  | {
      type: "ldp";
      signalId: string;
      pattern: string;
      detectedAt: string;
      referencePair: string;
      opTrigger: string;
      ldp: number;
      tickId?: string | undefined;
      timestamp: string;
    }
  | {
      type: "trigger";
      signalId: string;
      pattern: string;
      detectedAt: string;
      referencePair: string;
      opTrigger: string;
      ldp: number;
      eligibleTicksElapsed: number;
      tickId?: string | undefined;
      timestamp: string;
    }
  | {
      type: "expired";
      signalId: string;
      pattern: string;
      detectedAt: string;
      referencePair: string;
      opTrigger: string;
      ldp: number;
      eligibleTicksElapsed: number;
      timestamp: string;
    }
  | {
      type: "invalid-reference";
      signalId: string;
      pattern: string;
      patternTickIds: string[];
      patternTickTimestamps: string[];
      patternQuotes: Array<number | null>;
      detectedAt: string;
      referencePair: string;
    };

export interface X2XScannerStep {
  state: X2XScannerState;
  event: X2XScannerEvent | null;
}

export interface X2XBacktestResult {
  totalTicks: number;
  patternsDetected: number;
  validSignals: number;
  triggers: number;
  executedTrades: number;
  wins: number;
  losses: number;
  expiredSignals: number;
  rejectedSignals: number;
  unsettledTrades: number;
  winRate: number;
  /** No payout quote is available in a tick-only replay, so P/L is not estimated. */
  netPnl: null;
}

export const X2X_OP_WINDOW_TICKS = 10;

export function createX2XScannerState(): X2XScannerState {
  return {
    recentDigits: [],
    recentTickIds: [],
    recentTimestamps: [],
    recentQuotes: [],
    nextSignalSequence: 1,
    signal: null,
  };
}

export function cancelX2XScanner(state: X2XScannerState): {
  state: X2XScannerState;
  cancelledSignal: X2XScannerSignal | null;
} {
  return { state: createX2XScannerState(), cancelledSignal: state.signal };
}

export function isX2XScannerState(value: unknown): value is X2XScannerState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<X2XScannerState>;
  return (
    Array.isArray(state.recentDigits) &&
    state.recentDigits.length <= 3 &&
    state.recentDigits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9) &&
    Array.isArray(state.recentTickIds) &&
    state.recentTickIds.length <= 3 &&
    state.recentTickIds.every((id) => typeof id === "string") &&
    Array.isArray(state.recentTimestamps) &&
    state.recentTimestamps.length <= 3 &&
    state.recentTimestamps.every((timestamp) => typeof timestamp === "string") &&
    state.recentDigits.length === state.recentTickIds.length &&
    state.recentDigits.length === state.recentTimestamps.length &&
    Array.isArray(state.recentQuotes) &&
    state.recentDigits.length === state.recentQuotes.length &&
    Number.isInteger(state.nextSignalSequence) &&
    Number(state.nextSignalSequence) > 0 &&
    (state.signal === null ||
      (typeof state.signal === "object" &&
        typeof state.signal.id === "string" &&
        (state.signal.phase === "awaiting-ldp" || state.signal.phase === "awaiting-op") &&
        typeof state.signal.pattern === "string" &&
        Array.isArray(state.signal.patternTickIds) &&
        state.signal.patternTickIds.every((id) => typeof id === "string") &&
        Array.isArray(state.signal.patternTickTimestamps) &&
        state.signal.patternTickTimestamps.every((timestamp) => typeof timestamp === "string") &&
        Array.isArray(state.signal.patternQuotes) &&
        typeof state.signal.detectedAt === "string" &&
        typeof state.signal.referencePair === "string" &&
        typeof state.signal.opTrigger === "string" &&
        (typeof state.signal.ldp === "number" || state.signal.ldp === null) &&
        Number.isInteger(state.signal.eligibleTicksElapsed) &&
        Number.isInteger(state.signal.eligibleTicksRemaining)))
  );
}

/** Return false for an already-processed tick id and keep the cache bounded. */
export function rememberUniqueX2XTick(
  seenTickIds: Set<string>,
  tickId: string,
  maxSize = 256,
): boolean {
  if (seenTickIds.has(tickId)) return false;
  seenTickIds.add(tickId);
  while (seenTickIds.size > maxSize) {
    const oldest = seenTickIds.values().next().value;
    if (oldest === undefined) break;
    seenTickIds.delete(oldest);
  }
  return true;
}

/**
 * X2X's OP reference is the two decimal places from the quote on the third
 * pattern digit. Values below 20 are invalid under the PRD's non-negative rule.
 */
export function calculateX2XOpTrigger(referencePair: string): string | null {
  if (!/^\d{2}$/.test(referencePair)) return null;
  const value = Number(referencePair);
  if (value < 20) return null;
  return String(value - 20).padStart(2, "0");
}

/** Format a quote with its market precision and preserve its final two decimals. */
export function lastTwoQuoteDigits(quote: number, decimals = 2): string {
  return quote.toFixed(decimals).slice(-2);
}

/**
 * Advance one chronological tick. X2X is three successive tick digits X-2-X;
 * the next tick supplies LDP, and only the following ten eligible ticks can
 * match OP. While a signal is active, later X2X patterns are deliberately ignored.
 */
export function advanceX2XScanner(
  state: X2XScannerState,
  tick: X2XQuoteDigit,
  eligibleForOp: boolean,
): X2XScannerStep {
  const timestamp = tick.timestamp ?? new Date().toISOString();
  const recentDigits = [...state.recentDigits, tick.digit].slice(-3);
  const recentTickIds = [...state.recentTickIds, tick.tickId ?? ""].slice(-3);
  const recentTimestamps = [...state.recentTimestamps, timestamp].slice(-3);
  const recentQuotes = [...state.recentQuotes, tick.quote ?? null].slice(-3);
  const signal = state.signal;
  const baseState = {
    recentDigits,
    recentTickIds,
    recentTimestamps,
    recentQuotes,
    nextSignalSequence: state.nextSignalSequence,
  };
  const clearDigitWindow = {
    recentDigits: [] as number[],
    recentTickIds: [] as string[],
    recentTimestamps: [] as string[],
    recentQuotes: [] as Array<number | null>,
  };

  if (signal?.phase === "awaiting-ldp") {
    const nextSignal: X2XScannerSignal = {
      ...signal,
      phase: "awaiting-op",
      ldp: tick.digit,
      eligibleTicksElapsed: 0,
      eligibleTicksRemaining: X2X_OP_WINDOW_TICKS,
    };
    return {
      state: { ...baseState, signal: nextSignal },
      event: {
        type: "ldp",
        signalId: signal.id,
        pattern: signal.pattern,
        detectedAt: signal.detectedAt,
        referencePair: signal.referencePair,
        opTrigger: signal.opTrigger,
        ldp: tick.digit,
        tickId: tick.tickId,
        timestamp,
      },
    };
  }

  if (signal?.phase === "awaiting-op") {
    if (!eligibleForOp) return { state: { ...baseState, signal }, event: null };

    const eligibleTicksElapsed = signal.eligibleTicksElapsed + 1;
    if (tick.lastTwoQuoteDigits === signal.opTrigger) {
      return {
        state: { ...baseState, ...clearDigitWindow, signal: null },
        event: {
          type: "trigger",
          signalId: signal.id,
          pattern: signal.pattern,
          detectedAt: signal.detectedAt,
          referencePair: signal.referencePair,
          opTrigger: signal.opTrigger,
          ldp: signal.ldp as number,
          eligibleTicksElapsed,
          tickId: tick.tickId,
          timestamp,
        },
      };
    }

    if (eligibleTicksElapsed >= X2X_OP_WINDOW_TICKS) {
      return {
        state: { ...baseState, ...clearDigitWindow, signal: null },
        event: {
          type: "expired",
          signalId: signal.id,
          pattern: signal.pattern,
          detectedAt: signal.detectedAt,
          referencePair: signal.referencePair,
          opTrigger: signal.opTrigger,
          ldp: signal.ldp as number,
          eligibleTicksElapsed,
          timestamp,
        },
      };
    }

    return {
      state: {
        ...baseState,
        signal: {
          ...signal,
          eligibleTicksElapsed,
          eligibleTicksRemaining: X2X_OP_WINDOW_TICKS - eligibleTicksElapsed,
        },
      },
      event: null,
    };
  }

  if (recentDigits.length < 3) return { state: { ...baseState, signal: null }, event: null };

  const [first, middle, last] = recentDigits;
  if (first !== last || middle !== 2) return { state: { ...baseState, signal: null }, event: null };

  const pattern = recentDigits.join("");
  const patternTickIds = recentTickIds.filter(Boolean);
  const patternTickTimestamps = [...recentTimestamps];
  const patternQuotes = [...recentQuotes];
  const referencePair = tick.lastTwoQuoteDigits;
  const signalId = tick.tickId
    ? `x2x-${tick.tickId}`
    : `x2x-${state.nextSignalSequence}-${timestamp}`;
  const nextSignalSequence = state.nextSignalSequence + 1;
  const opTrigger = calculateX2XOpTrigger(referencePair);
  if (opTrigger === null) {
    return {
      state: { ...baseState, ...clearDigitWindow, nextSignalSequence, signal: null },
      event: {
        type: "invalid-reference",
        signalId,
        pattern,
        patternTickIds,
        patternTickTimestamps,
        patternQuotes,
        detectedAt: timestamp,
        referencePair,
      },
    };
  }

  const nextSignal: X2XScannerSignal = {
    id: signalId,
    phase: "awaiting-ldp",
    pattern,
    patternTickIds,
    patternTickTimestamps,
    patternQuotes,
    detectedAt: timestamp,
    referencePair,
    opTrigger,
    ldp: null,
    eligibleTicksElapsed: 0,
    eligibleTicksRemaining: 0,
  };
  return {
    state: { ...baseState, nextSignalSequence, signal: nextSignal },
    event: {
      type: "pattern",
      signalId,
      pattern,
      patternTickIds,
      patternTickTimestamps,
      patternQuotes,
      detectedAt: timestamp,
      referencePair,
      opTrigger,
    },
  };
}

/** Replay historical quotes through the exact live scanner without placing trades. */
export function runX2XBacktest(
  ticks: X2XQuoteDigit[],
  options: { reAnalyzeOnLoss?: boolean; cooldownTicks?: number } = {},
): X2XBacktestResult {
  let state = createX2XScannerState();
  let patternsDetected = 0;
  let validSignals = 0;
  let triggers = 0;
  let executedTrades = 0;
  let wins = 0;
  let losses = 0;
  let expiredSignals = 0;
  let rejectedSignals = 0;
  let contractTarget: number | null = null;
  const seenTickIds = new Set<string>();
  let cooldownRemaining = 0;
  const cooldownLength = Math.max(0, Math.floor(options.cooldownTicks ?? 5));
  const reAnalyzeOnLoss = options.reAnalyzeOnLoss ?? true;

  for (const tick of ticks) {
    if (tick.tickId && !rememberUniqueX2XTick(seenTickIds, tick.tickId)) continue;
    const settlingTarget = contractTarget;
    const cooldownAtStart = cooldownRemaining;
    const step = advanceX2XScanner(state, tick, settlingTarget === null && cooldownAtStart === 0);
    state = step.state;

    if (settlingTarget !== null) {
      if (tick.digit === settlingTarget) wins++;
      else {
        losses++;
        if (reAnalyzeOnLoss) cooldownRemaining = cooldownLength;
      }
      contractTarget = null;
    }
    if (cooldownAtStart > 0 && cooldownRemaining === cooldownAtStart) cooldownRemaining--;

    switch (step.event?.type) {
      case "pattern":
        patternsDetected++;
        break;
      case "ldp":
        validSignals++;
        break;
      case "trigger":
        triggers++;
        executedTrades++;
        contractTarget = step.event.ldp;
        break;
      case "expired":
        expiredSignals++;
        break;
      case "invalid-reference":
        patternsDetected++;
        rejectedSignals++;
        break;
    }
  }

  const settledTrades = wins + losses;
  return {
    totalTicks: ticks.length,
    patternsDetected,
    validSignals,
    triggers,
    executedTrades,
    wins,
    losses,
    expiredSignals,
    rejectedSignals,
    unsettledTrades: executedTrades - settledTrades,
    winRate: settledTrades > 0 ? (wins / settledTrades) * 100 : 0,
    netPnl: null,
  };
}
