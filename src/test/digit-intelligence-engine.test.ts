import { describe, expect, it } from "vitest";
import {
  analyzeResearchHistory,
  assessDigitMatchTrade,
  buildDigitTransitionMatrix,
  createDefaultResearchSettings,
  rankDigitSequences,
  runResearchBacktest,
  trainModelAgreementWeights,
  type EnsembleExpertId,
} from "@/lib/digit-intelligence-engine";

const predictiveStrategies: EnsembleExpertId[] = [
  "transition_matrix",
  "markov_first",
  "markov_second",
  "two_digit_sequence",
  "three_digit_sequence",
  "conditional_probability",
];

function settings(window = 100) {
  return Object.fromEntries(
    Object.entries(createDefaultResearchSettings()).map(([id, config]) => [
      id,
      { ...config, window, minimumSamples: 2, minimumConfidence: 10 },
    ]),
  ) as ReturnType<typeof createDefaultResearchSettings>;
}

describe("Digit Intelligence research engine", () => {
  it("counts all 100 chronological digit transitions with independent row samples", () => {
    const matrix = buildDigitTransitionMatrix([1, 2, 1, 2, 3]);

    expect(matrix[1]?.samples).toBe(2);
    expect(matrix[1]?.cells[2]).toMatchObject({ count: 2, probability: 1 });
    expect(matrix[2]?.samples).toBe(2);
    expect(matrix[2]?.cells[1]?.count).toBe(1);
    expect(matrix[2]?.cells[3]?.count).toBe(1);
    expect(matrix.flatMap((row) => row.cells)).toHaveLength(100);
  });

  it("ranks recurring sequence contexts by observed next-digit frequencies", () => {
    const ranked = rankDigitSequences([5, 2, 5, 8, 5, 2, 5, 8, 5, 2, 5, 9], 3, 2);
    expect(ranked[0]).toMatchObject({
      context: "525",
      samples: 3,
      nextDigit: 8,
      probability: 2 / 3,
    });
  });

  it("keeps frequency rankings descriptive and refuses a live signal before holdout validation", () => {
    const digits = Array.from({ length: 100 }, (_, index) => index % 2);
    const analysis = analyzeResearchHistory(digits, settings());

    expect(analysis.frequencies).toHaveLength(10);
    expect(analysis.frequencyRanking[0]?.digit).toBe(0);
    expect(analysis.modules.find((item) => item.id === "rolling_frequency")?.signalEligible).toBe(
      false,
    );
    expect(analysis.signalEligible).toBe(false);
    expect(analysis.liveTradingStatus).toContain("locked");
  });

  it("includes an evidence-weighted streak expert in the multi-model analysis", () => {
    const digits = Array.from(
      { length: 200 },
      (_, index) => [2, 7, 2, 4, 9, 2, 1, 2][index % 8] ?? 0,
    );
    const analysis = analyzeResearchHistory(digits, settings());
    const ensemble = analysis.modules.find((item) => item.id === "multi_model_agreement");

    expect(ensemble?.ensembleVotes.some((vote) => vote.id === "streak_context")).toBe(true);
  });

  it("uses trailing contexts only and waits for minimum context samples", () => {
    const digits = Array.from({ length: 120 }, (_, index) => [5, 2, 5, 8][index % 4] ?? 0);
    const analysis = analyzeResearchHistory(digits, settings());

    expect(analysis.markovOrder1.context).toBe("8");
    expect(analysis.markovOrder1.samples).toBeGreaterThan(2);
    expect(analysis.markovOrder2.context).toBe("58");
    expect(analysis.markovOrder2.predictedDigit).toBe(5);
    expect(analysis.sequenceOrder3.context).toBe("258");
    expect(analysis.sequenceOrder3.predictedDigit).toBe(5);

    const sparse = analyzeResearchHistory(digits, {
      ...settings(),
      markov_chain: { ...settings().markov_chain, minimumSamples: 100 },
    });
    expect(sparse.markovOrder1.predictedDigit).toBeNull();
  });

  it("splits chronologically and keeps even a validated synthetic model locked from trading", () => {
    const digits = Array.from({ length: 1000 }, (_, index) => index % 2);
    const result = runResearchBacktest(digits, settings());

    expect(result.development.endIndex).toBe(600);
    expect(result.validation.startIndex).toBe(600);
    expect(result.validation.endIndex).toBe(800);
    expect(result.finalTest.startIndex).toBe(800);
    expect(result.finalTest.endIndex).toBe(1000);
    expect(result.walkForward).toBe(true);
    expect(result.models.every((model) => model.expectedValue === null)).toBe(true);
    expect(result.models.every((model) => model.liveEligible === false)).toBe(true);
    expect(result.models.some((model) => model.status === "validated")).toBe(true);
    expect(
      result.models
        .filter((model) => model.status === "validated")
        .every((model) => model.expectedValue === null && model.liveEligible === false),
    ).toBe(true);
  });

  it("fits model-agreement weights from development examples rather than equal votes", () => {
    const examples = Array.from({ length: 120 }, (_, index) => ({
      targetDigit: index % 2 === 0 ? 7 : 3,
      distributions: {
        transition_matrix:
          index % 2 === 0
            ? [0.01, 0.01, 0.01, 0.1, 0.01, 0.01, 0.01, 0.8, 0.03, 0.01]
            : [0.01, 0.01, 0.01, 0.8, 0.01, 0.01, 0.01, 0.1, 0.03, 0.01],
        markov_first: Array(10).fill(0.1),
      },
    }));
    const weights = trainModelAgreementWeights(examples);

    expect(weights.transition_matrix).toBeGreaterThan(weights.markov_first);
    expect(predictiveStrategies).toContain("conditional_probability");
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("waits until a module's full configured window is present", () => {
    const config = settings();
    config.transition_matrix.window = 100;
    const digits = Array.from({ length: 99 }, (_, index) => index % 10);

    const beforeWindow = analyzeResearchHistory(digits, config);
    expect(
      beforeWindow.modules.find((item) => item.id === "transition_matrix")?.targetDigit,
    ).toBeNull();

    const completeWindow = analyzeResearchHistory([...digits, 9], config);
    expect(
      completeWindow.modules.find((item) => item.id === "transition_matrix")?.targetDigit,
    ).not.toBeNull();
  });

  it("blocks a live assessment if the proposal stake or daily risk basis is invalid", () => {
    const valid = {
      validated: true,
      estimate: 0.2,
      lowerConfidenceBound: 0.15,
      minimumEstimate: 0.12,
      stake: 1,
      proposalAsk: 1,
      proposalPayout: 9,
      balance: 100,
      dailyTrades: 0,
      dailyLoss: 0,
      consecutiveLosses: 0,
      openContracts: 0,
      testingBalance: 100,
    };
    expect(assessDigitMatchTrade({ ...valid, proposalAsk: 2 }).eligible).toBe(false);
    expect(assessDigitMatchTrade({ ...valid, testingBalance: 0 }).eligible).toBe(false);
    expect(assessDigitMatchTrade({ ...valid, estimate: Number.NaN }).eligible).toBe(false);
  });

  it("uses the holdout lower bound for expected value and reserves the remaining daily loss limit", () => {
    const valid = {
      validated: true,
      estimate: 0.2,
      lowerConfidenceBound: 0.15,
      minimumEstimate: 0.12,
      stake: 1,
      proposalAsk: 1,
      proposalPayout: 9,
      balance: 100,
      dailyTrades: 0,
      dailyLoss: 0,
      consecutiveLosses: 0,
      openContracts: 0,
      testingBalance: 100,
      maxDailyLossPercent: 3,
      minimumExpectedValue: 0.02,
    };

    const assessment = assessDigitMatchTrade(valid);
    expect(assessment.eligible).toBe(true);
    expect(assessment.expectedValue).toBeCloseTo(0.35);
    expect(assessDigitMatchTrade({ ...valid, lowerConfidenceBound: 0.11 }).eligible).toBe(false);
    expect(assessDigitMatchTrade({ ...valid, dailyLoss: 2.25 }).eligible).toBe(false);
    expect(assessDigitMatchTrade({ ...valid, consecutiveLosses: 3 }).eligible).toBe(false);
  });
});
