import type { MarketSymbol } from "./matches";

export const ENTRY_MATCH_WAIT_TICKS_MIN = 1;
export const ENTRY_MATCH_WAIT_TICKS_MAX = 10;
export const DEFAULT_ENTRY_MATCH_WAIT_TICKS = 1;

/** Keep the Entry Match cadence inside the supported 1–10 live tick range. */
export function normalizeEntryMatchWaitTicks(value: unknown): number {
  const ticks = Number(value);
  if (!Number.isFinite(ticks)) return DEFAULT_ENTRY_MATCH_WAIT_TICKS;
  return Math.min(
    ENTRY_MATCH_WAIT_TICKS_MAX,
    Math.max(ENTRY_MATCH_WAIT_TICKS_MIN, Math.floor(ticks)),
  );
}

/** Advance a capped countdown by exactly one fresh, eligible live tick. */
export function advanceEntryMatchWaitCount(waitedTicks: number, requiredTicks: number): number {
  const required = normalizeEntryMatchWaitTicks(requiredTicks);
  const elapsed = Number.isFinite(waitedTicks) ? Math.max(0, Math.floor(waitedTicks)) : 0;
  return Math.min(required, elapsed + 1);
}

export interface EntryMatchTick {
  digit: number;
  quote: number;
  tickId?: string | undefined;
  timestamp?: string | undefined;
}

/** Immutable values captured from the single feed event that initiates a trade. */
export interface EntryMatchOrder {
  readonly marketSymbol: MarketSymbol;
  readonly entryDigit: number;
  readonly matchesPrediction: number;
  readonly entryQuote: number;
  readonly entryTickId: string | null;
  readonly entryTimestamp: string | null;
}

/**
 * Build a fresh Entry Match order from one chronological market tick.
 * Both the trade's ENTRY_DIGIT and its Matches barrier come from this same event.
 */
export function captureEntryMatchOrder(
  tick: EntryMatchTick,
  marketSymbol: MarketSymbol,
): EntryMatchOrder {
  if (!Number.isFinite(tick.quote)) {
    throw new Error("Entry Match requires a finite quote from the current market tick.");
  }
  if (!Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9) {
    throw new Error("Entry Match requires a valid last digit from the current market tick.");
  }

  const entryDigit = tick.digit;
  return Object.freeze({
    marketSymbol,
    entryDigit,
    matchesPrediction: entryDigit,
    entryQuote: tick.quote,
    entryTickId: tick.tickId ?? null,
    entryTimestamp: tick.timestamp ?? null,
  });
}
