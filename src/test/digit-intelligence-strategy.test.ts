import { describe, expect, it } from "vitest";
import {
  analyzeDigitIntelligence,
  backtestDigitIntelligence,
  type DigitIntelligenceSettings,
} from "@/lib/digit-intelligence-strategy";
import { lastDigit, MARKET_LIST } from "@/lib/matches";

const settings: DigitIntelligenceSettings = {
  window: 50,
  minimumConfidence: 0,
  minimumSequenceSamples: 3,
  target: "auto",
};

function repeatedPattern(repetitions: number): number[] {
  return Array.from({ length: repetitions * 3 }, (_, index) => [5, 0, 8][index % 3] ?? 0);
}

describe("Digit Intelligence strategy", () => {
  it("reports digit frequencies, absence streaks, and the current repeated run", () => {
    const digits = [...Array.from({ length: 47 }, () => 1), 6, 6, 6];
    const result = analyzeDigitIntelligence(digits, settings);

    expect(result.ready).toBe(true);
    expect(result.frequencies.reduce((sum, row) => sum + row.count, 0)).toBe(50);
    expect(result.frequencies[1]).toMatchObject({ count: 47, representation: "over" });
    expect(result.frequencies[6]).toMatchObject({ count: 3, representation: "under" });
    expect(result.absenceStreaks[6]).toBe(0);
    expect(result.absenceStreaks[1]).toBe(3);
    expect(result.currentRunDigit).toBe(6);
    expect(result.currentRunLength).toBe(3);
  });

  it("uses historical followers of the current sequence and reports a transparent evidence score", () => {
    const digits = repeatedPattern(40).slice(-50);
    const result = analyzeDigitIntelligence(digits, { ...settings, target: 5 });

    expect(result.activeSequence).toMatchObject({ pattern: "08", length: 2, samples: 16 });
    expect(result.activeSequence?.nextDigitCounts[5]).toBe(16);
    expect(result.targetDigit).toBe(5);
    expect(result.confidence).not.toBeNull();
    expect(result.confidenceMeaning).toBe(
      "model agreement and evidence support, not win probability",
    );
    expect(result.signalReady).toBe(true);
    expect(
      result.recurringSequences.some(
        (sequence) => sequence.pattern === "08" && sequence.nextDigit === 5,
      ),
    ).toBe(true);
  });

  it("waits for both the selected window and enough observations of the current sequence", () => {
    const short = analyzeDigitIntelligence(repeatedPattern(16).slice(-49), settings);
    expect(short.ready).toBe(false);
    expect(short.signalReady).toBe(false);

    const highSampleThreshold = analyzeDigitIntelligence(repeatedPattern(20).slice(-50), {
      ...settings,
      minimumSequenceSamples: 30,
    });
    expect(highSampleThreshold.activeSequence).toBeNull();
    expect(highSampleThreshold.signalReady).toBe(false);
    expect(highSampleThreshold.reason).toContain("historical followers");
  });

  it("scores only future, held-out ticks and reports the 10% random baseline", () => {
    const digits = repeatedPattern(200);
    const replay = backtestDigitIntelligence(digits, settings);

    expect(replay.totalTicks).toBe(600);
    expect(replay.evaluatedTicks).toBe(550);
    expect(replay.signals).toBeGreaterThan(0);
    expect(replay.correct + replay.incorrect).toBe(replay.signals);
    expect(replay.baselineAccuracy).toBe(10);
    expect(replay.frequencyBaselineAccuracy).toBeGreaterThanOrEqual(0);
    expect(replay.frequencyBaselineAccuracy).toBeLessThanOrEqual(100);
    expect(replay.coverage).toBeCloseTo((replay.signals / replay.evaluatedTicks) * 100);
    expect(replay.accuracy).toBe(100);
  });

  it.each(MARKET_LIST)("accepts an independent digit stream for $id", (market) => {
    const quotes = Array.from(
      { length: 50 },
      (_, index) => 100 + ([5, 0, 8][index % 3] ?? 0) / 10 ** market.pipDecimals,
    );
    const marketDigits = quotes.map((quote) => lastDigit(quote, market.pipDecimals));
    const result = analyzeDigitIntelligence(marketDigits, settings);

    expect(marketDigits).toHaveLength(50);
    expect(marketDigits.every((digit) => digit >= 0 && digit <= 9)).toBe(true);
    expect(result.sampleSize).toBe(50);
    expect(result.activeSequence?.pattern).toBe("50");
    expect(result.activeSequence?.nextDigitCounts[8]).toBeGreaterThan(0);
  });
});
