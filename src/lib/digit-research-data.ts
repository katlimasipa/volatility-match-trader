import { getMarketConfig, type MarketSymbol } from "@/lib/matches";
import { decimalQuote, digitFromQuote } from "@/lib/decimal-quote";
import { RESEARCH_MARKETS, type ResearchMarket } from "@/lib/digit-intelligence-engine";

export interface ResearchTick {
  epoch: number;
  quote: string;
  digit: number;
  source: "history" | "live";
}

export const RESEARCH_TICK_LIMIT = 5_000;
export const RESEARCH_HISTORY_REQUEST_COUNT = 5_000;

function isResearchMarket(value: unknown): value is ResearchMarket {
  return typeof value === "string" && RESEARCH_MARKETS.includes(value as ResearchMarket);
}

function validPrecision(value: unknown, fallback: number): number {
  const precision = Number(value);
  return Number.isInteger(precision) && precision >= 0 && precision <= 10 ? precision : fallback;
}

function makeTick(
  quoteValue: unknown,
  epochValue: unknown,
  market: ResearchMarket,
  source: ResearchTick["source"],
  precision = getMarketConfig(market).pipDecimals,
): ResearchTick | null {
  if (
    (typeof quoteValue !== "number" && typeof quoteValue !== "string") ||
    !Number.isFinite(Number(quoteValue))
  )
    return null;
  const epoch = Number(epochValue);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const quote = decimalQuote(quoteValue, precision);
  const digit = digitFromQuote(quoteValue, precision);
  return quote && digit !== null ? { epoch, quote, digit, source } : null;
}

/** Reads the compact persisted tick format and validates every row. */
export function parseStoredResearchTicks(saved: unknown): ResearchTick[] {
  if (!Array.isArray(saved)) return [];
  const valid = saved.flatMap((entry): ResearchTick[] => {
    const candidate =
      Array.isArray(entry) && entry.length >= 4
        ? { epoch: entry[0], quote: entry[1], digit: entry[2], source: entry[3] }
        : entry;
    if (!candidate || typeof candidate !== "object") return [];
    const tick = candidate as Partial<ResearchTick>;
    return Number.isFinite(tick.epoch) &&
      typeof tick.quote === "string" &&
      Number.isInteger(tick.digit) &&
      Number(tick.digit) >= 0 &&
      Number(tick.digit) <= 9 &&
      (tick.source === "history" || tick.source === "live")
      ? [
          {
            epoch: Number(tick.epoch),
            quote: tick.quote,
            digit: Number(tick.digit),
            source: tick.source,
          },
        ]
      : [];
  });
  return mergeResearchTicks([], valid);
}

/** Parses only real, timestamped ticks returned by Deriv history; bad rows are skipped. */
export function parseResearchHistory(response: unknown, market: ResearchMarket): ResearchTick[] {
  if (!response || typeof response !== "object") return [];
  const root = response as Record<string, unknown>;
  const history = root["history"];
  if (!history || typeof history !== "object") return [];
  const record = history as Record<string, unknown>;
  const rawPrices = record["prices"];
  const rawTimes = record["times"];
  if (!Array.isArray(rawPrices) || !Array.isArray(rawTimes)) return [];
  const fallback = getMarketConfig(market).pipDecimals;
  const precision = validPrecision(root["pip_size"], fallback);
  const ticks: ResearchTick[] = [];
  const prices = rawPrices;
  const times = rawTimes;
  const length = Math.min(prices.length, times.length);
  for (let index = 0; index < length; index++) {
    const tick = makeTick(prices[index], times[index], market, "history", precision);
    if (tick) ticks.push(tick);
  }
  return ticks.sort((a, b) => a.epoch - b.epoch);
}

/** Converts a real Deriv subscription message into a single market tick. */
export function parseResearchLiveTick(
  message: unknown,
  capturedAtMs = Date.now(),
): { market: ResearchMarket; tick: ResearchTick } | null {
  if (!message || typeof message !== "object") return null;
  const root = message as Record<string, unknown>;
  const tickData = root["tick"];
  const candidate =
    tickData && typeof tickData === "object" ? (tickData as Record<string, unknown>) : root;
  const symbol = candidate["symbol"];
  if (!isResearchMarket(symbol)) return null;
  const market = symbol;
  const fallback = getMarketConfig(market).pipDecimals;
  const precision = validPrecision(candidate["pip_size"] ?? root["pip_size"], fallback);
  const time = Number(candidate["epoch"]);
  const epoch = Number.isFinite(time) && time > 0 ? time : capturedAtMs / 1000;
  const tick = makeTick(candidate["quote"], epoch, market, "live", precision);
  return tick ? { market, tick } : null;
}

/** Merges without mixing markets, sorts chronologically and bounds local storage. */
export function mergeResearchTicks(
  existing: ResearchTick[],
  incoming: ResearchTick[],
  limit = RESEARCH_TICK_LIMIT,
): ResearchTick[] {
  const unique = new Map<string, ResearchTick>();
  for (const tick of [...existing, ...incoming]) {
    if (
      !Number.isFinite(tick.epoch) ||
      !Number.isInteger(tick.digit) ||
      tick.digit < 0 ||
      tick.digit > 9
    )
      continue;
    unique.set(`${tick.epoch}:${tick.quote}`, tick);
  }
  return [...unique.values()].sort((a, b) => a.epoch - b.epoch).slice(-Math.max(1, limit));
}

export function researchTickStorageKey(market: MarketSymbol): string {
  return `thdpst-digit-research:ticks:v1:${market}`;
}
