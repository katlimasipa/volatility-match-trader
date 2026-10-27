import type { MarketSymbol } from "./matches";

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
