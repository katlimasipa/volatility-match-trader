import { describe, expect, it } from "vitest";
import { MARKET_LIST } from "@/lib/matches";
import { RESEARCH_MARKETS } from "@/lib/digit-intelligence-engine";
import {
  mergeResearchTicks,
  parseResearchHistory,
  parseResearchLiveTick,
  type ResearchTick,
} from "@/lib/digit-research-data";

describe("research tick data", () => {
  it("covers every market already supported by the bot with its own quote precision", () => {
    expect(RESEARCH_MARKETS).toEqual(MARKET_LIST.map((market) => market.id));
    for (const market of MARKET_LIST) {
      const decimals = "1234567890".slice(0, market.pipDecimals);
      const quote = `1234.${decimals}`;
      const parsed = parseResearchLiveTick({
        tick: {
          symbol: market.id,
          quote,
          epoch: 123,
          pip_size: market.pipDecimals,
        },
      });

      expect(parsed?.market).toBe(market.id);
      expect(parsed?.tick.quote).toBe(quote);
      expect(parsed?.tick.digit).toBe(Number(decimals.at(-1)));
    }
  });

  it("keeps history chronological and extracts digits using market precision", () => {
    const ticks = parseResearchHistory(
      {
        pip_size: 2,
        history: { prices: [1234.27, 1234.08, "1234.91"], times: [3, 1, 2] },
      },
      "R_100",
    );

    expect(ticks.map(({ epoch, quote, digit }) => [epoch, quote, digit])).toEqual([
      [1, "1234.08", 8],
      [2, "1234.91", 1],
      [3, "1234.27", 7],
    ]);
  });

  it("skips malformed rows and never invents timestamps for history", () => {
    const ticks = parseResearchHistory(
      {
        history: { prices: ["1234.27", "bad", "1234.12"], times: [10, 11] },
      },
      "R_100",
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.epoch).toBe(10);
  });

  it("routes live ticks by their own market and timestamps missing epochs at capture time", () => {
    const parsed = parseResearchLiveTick({ tick: { symbol: "R_75", quote: "913.57" } }, 20_000);
    expect(parsed).toMatchObject({
      market: "R_75",
      tick: { epoch: 20, quote: "913.57", digit: 7, source: "live" },
    });
    expect(parseResearchLiveTick({ tick: { quote: 913.57 } }, 20_000)).toBeNull();
  });

  it("deduplicates, sorts and bounds each market's independent history", () => {
    const first: ResearchTick = { epoch: 2, quote: "2.2", digit: 2, source: "history" };
    const duplicate: ResearchTick = { ...first, source: "live" };
    const merged = mergeResearchTicks(
      [{ epoch: 3, quote: "3.3", digit: 3, source: "history" }, first],
      [duplicate, { epoch: 1, quote: "1.1", digit: 1, source: "live" }],
      2,
    );
    expect(merged.map((tick) => tick.epoch)).toEqual([2, 3]);
  });
});
