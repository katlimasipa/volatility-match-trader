import {
  runResearchBacktest,
  type DigitResearchBacktest,
  type ResearchSettings,
} from "@/lib/digit-intelligence-engine";

interface BacktestRequest {
  digits: number[];
  settings: ResearchSettings;
}

interface BacktestResponse {
  result?: DigitResearchBacktest;
  error?: string;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BacktestRequest>) => void) | null;
  postMessage: (message: BacktestResponse) => void;
};

workerScope.onmessage = (event) => {
  try {
    workerScope.postMessage({
      result: runResearchBacktest(event.data.digits, event.data.settings),
    });
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : "Backtest failed." });
  }
};

export {};
