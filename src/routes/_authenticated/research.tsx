import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  Check,
  ChevronDown,
  Download,
  FlaskConical,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  analyzeResearchHistory,
  createDefaultResearchSettings,
  rankDigitSequences,
  RESEARCH_MARKETS,
  RESEARCH_MULTIPLE_TEST_FAMILY_SIZE,
  RESEARCH_STRATEGIES,
  RESEARCH_WINDOWS,
  assessDigitMatchTrade,
  type DigitResearchAnalysis,
  type DigitResearchBacktest,
  type EnsembleExpertId,
  type ResearchMarket,
  type ResearchSettings,
  type ResearchStrategyId,
  type ResearchWindow,
  wilsonInterval,
} from "@/lib/digit-intelligence-engine";
import {
  mergeResearchTicks,
  parseStoredResearchTicks,
  parseResearchHistory,
  parseResearchLiveTick,
  RESEARCH_HISTORY_REQUEST_COUNT,
  RESEARCH_TICK_LIMIT,
  type ResearchTick,
} from "@/lib/digit-research-data";
import {
  deleteResearchValue,
  readResearchValue,
  writeResearchValue,
} from "@/lib/digit-research-storage";
import { DerivWS } from "@/lib/deriv-ws";
import { getMarketConfig } from "@/lib/matches";
import {
  getActiveAccountId,
  getStoredAccounts,
  hasUsableDerivAuthorization,
  type DerivAccount,
} from "@/lib/deriv-auth";
import { DerivTradingSession, type ContractResult } from "@/lib/deriv-trading";

export const Route = createFileRoute("/_authenticated/research")({
  ssr: false,
  component: DigitResearchLab,
});

type ResearchMode = "research" | "observation" | "live";
type ConnectionState = "connecting" | "live" | "offline";
type MarketRecord<T> = Record<ResearchMarket, T>;
type BacktestRange = "all" | 1000 | 2500 | 5000;

interface ObservationPrediction {
  predictions: Array<number | null>;
  configKeys: string[];
  basedOnEpoch: number;
  basedOnQuote: string;
}

interface ObservationScore {
  epoch: number;
  outcome: number;
  quote?: string;
  predictions: Array<number | null>;
  configKeys: string[];
}

interface FeedInfo {
  historyLoaded: boolean;
  historyError: string | null;
  lastLiveAt: number | null;
  liveTicks: number;
}

interface SavedBacktest {
  settingsKey: string;
  ranAt: number;
  result: DigitResearchBacktest;
}

interface LiveRiskSettings {
  stake: number;
  testingBalance: number;
  maxDailyTrades: number;
  maxDailyLossPercent: number;
  maxConsecutiveLosses: number;
  minimumExpectedValueMarginPercent: number;
}

interface LiveTradeRecord {
  market: ResearchMarket;
  strategy: ResearchStrategyId;
  timestamp: number;
  prediction: number;
  quoteAtSignal: string;
  quoteAtPurchase: string;
  contractId: number;
  won: boolean;
  profit: number;
  payout: number;
  buyPrice: number;
  exitDigit: number | null;
}

interface LivePause {
  market: ResearchMarket;
  reason: string;
  timestamp: number;
}

const SETTINGS_KEY = "thdpst-digit-research:settings:v1:";
const OBSERVATIONS_KEY = "thdpst-digit-research:observations:v1:";
const BACKTEST_KEY = "thdpst-digit-research:backtest:v1:";
const BACKTEST_RANGE_KEY = "thdpst-digit-research:backtest-range:v1:";
const LIVE_PERMISSION_KEY = "thdpst-digit-research:live-permission:v1:";
const LIVE_RISK_KEY = "thdpst-digit-research:live-risk:v1:";
const LIVE_TRADES_KEY = "thdpst-digit-research:live-trades:v1:";
const DEFAULT_LIVE_RISK: LiveRiskSettings = {
  stake: 1,
  testingBalance: 100,
  maxDailyTrades: 20,
  maxDailyLossPercent: 3,
  maxConsecutiveLosses: 3,
  minimumExpectedValueMarginPercent: 2,
};
const MAX_OBSERVATIONS = 2_000;
const MODULE_INDEX = new Map(RESEARCH_STRATEGIES.map((id, index) => [id, index]));
const MODULE_LABELS: Record<ResearchStrategyId, string> = {
  rolling_frequency: "Rolling digit frequency",
  mad: "Most appearing digit",
  least_appearing: "Least appearing digit",
  transition_matrix: "Digit transition matrix",
  markov_chain: "Markov chain",
  two_digit_sequence: "Two-digit sequence",
  three_digit_sequence: "Three-digit sequence",
  conditional_probability: "Conditional probability",
  multi_model_agreement: "Multi-model agreement",
  edge_validation: "Statistical edge validation",
};

function marketRecord<T>(factory: (market: ResearchMarket) => T): MarketRecord<T> {
  return Object.fromEntries(
    RESEARCH_MARKETS.map((market) => [market, factory(market)]),
  ) as MarketRecord<T>;
}

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function loadTicks(market: ResearchMarket): ResearchTick[] {
  const saved = readStorage<unknown>(`thdpst-digit-research:ticks:v1:${market}`, []);
  return parseStoredResearchTicks(saved);
}

function loadSettings(market: ResearchMarket): ResearchSettings {
  const defaults = createDefaultResearchSettings();
  const saved = readStorage<
    Partial<Record<ResearchStrategyId, Partial<ResearchSettings[ResearchStrategyId]>>>
  >(`${SETTINGS_KEY}${market}`, {});
  const output = createDefaultResearchSettings();
  for (const id of RESEARCH_STRATEGIES) {
    const value = saved[id];
    if (!value || typeof value !== "object") continue;
    const window = RESEARCH_WINDOWS.includes(value.window as ResearchWindow)
      ? (value.window as ResearchWindow)
      : defaults[id].window;
    const target =
      value.target === "auto" ||
      (Number.isInteger(value.target) && Number(value.target) >= 0 && Number(value.target) <= 9)
        ? (value.target as "auto" | number)
        : defaults[id].target;
    output[id] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults[id].enabled,
      window,
      minimumSamples: Number.isFinite(Number(value.minimumSamples))
        ? Math.max(1, Math.min(5000, Math.floor(Number(value.minimumSamples))))
        : defaults[id].minimumSamples,
      minimumConfidence: Number.isFinite(Number(value.minimumConfidence))
        ? Math.max(0, Math.min(100, Number(value.minimumConfidence)))
        : defaults[id].minimumConfidence,
      target,
    };
  }
  return output;
}

function parseStoredObservations(saved: unknown): ObservationScore[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (item): item is ObservationScore =>
        !!item &&
        typeof item === "object" &&
        Number.isFinite((item as ObservationScore).epoch) &&
        Number.isInteger((item as ObservationScore).outcome) &&
        (item as ObservationScore).outcome >= 0 &&
        (item as ObservationScore).outcome <= 9 &&
        Array.isArray((item as ObservationScore).predictions) &&
        Array.isArray((item as ObservationScore).configKeys),
    )
    .slice(-MAX_OBSERVATIONS);
}

function loadObservations(market: ResearchMarket): ObservationScore[] {
  return parseStoredObservations(readStorage<unknown>(`${OBSERVATIONS_KEY}${market}`, []));
}

function loadBacktest(market: ResearchMarket): SavedBacktest | null {
  const saved = readStorage<unknown>(`${BACKTEST_KEY}${market}`, null);
  if (!saved || typeof saved !== "object") return null;
  const record = saved as SavedBacktest;
  return record.result?.models && typeof record.settingsKey === "string" ? record : null;
}

function loadBacktestRange(market: ResearchMarket): BacktestRange {
  const value = readStorage<unknown>(`${BACKTEST_RANGE_KEY}${market}`, "all");
  return value === "all" || value === 1000 || value === 2500 || value === 5000 ? value : "all";
}

function loadLivePermissions(market: ResearchMarket): Record<ResearchStrategyId, boolean> {
  const saved = readStorage<Partial<Record<ResearchStrategyId, boolean>>>(
    `${LIVE_PERMISSION_KEY}${market}`,
    {},
  );
  return Object.fromEntries(RESEARCH_STRATEGIES.map((id) => [id, saved[id] === true])) as Record<
    ResearchStrategyId,
    boolean
  >;
}

function loadLiveRisk(market: ResearchMarket): LiveRiskSettings {
  const saved = readStorage<Partial<LiveRiskSettings>>(`${LIVE_RISK_KEY}${market}`, {});
  return {
    stake: Number.isFinite(Number(saved.stake))
      ? Math.max(0.35, Math.min(1000, Number(saved.stake)))
      : DEFAULT_LIVE_RISK.stake,
    testingBalance: Number.isFinite(Number(saved.testingBalance))
      ? Math.max(1, Number(saved.testingBalance))
      : DEFAULT_LIVE_RISK.testingBalance,
    maxDailyTrades: Number.isFinite(Number(saved.maxDailyTrades))
      ? Math.max(1, Math.min(100, Math.floor(Number(saved.maxDailyTrades))))
      : DEFAULT_LIVE_RISK.maxDailyTrades,
    maxDailyLossPercent: Number.isFinite(Number(saved.maxDailyLossPercent))
      ? Math.max(0.5, Math.min(3, Number(saved.maxDailyLossPercent)))
      : DEFAULT_LIVE_RISK.maxDailyLossPercent,
    maxConsecutiveLosses: Number.isFinite(Number(saved.maxConsecutiveLosses))
      ? Math.max(1, Math.min(10, Math.floor(Number(saved.maxConsecutiveLosses))))
      : DEFAULT_LIVE_RISK.maxConsecutiveLosses,
    minimumExpectedValueMarginPercent: Number.isFinite(
      Number(saved.minimumExpectedValueMarginPercent),
    )
      ? Math.max(0, Math.min(100, Number(saved.minimumExpectedValueMarginPercent)))
      : DEFAULT_LIVE_RISK.minimumExpectedValueMarginPercent,
  };
}

function parseStoredLiveTrades(saved: unknown, market: ResearchMarket): LiveTradeRecord[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((entry): entry is LiveTradeRecord => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Partial<LiveTradeRecord>;
      return (
        row.market === market &&
        RESEARCH_STRATEGIES.includes(row.strategy as ResearchStrategyId) &&
        Number.isFinite(row.timestamp) &&
        Number.isInteger(row.prediction) &&
        Number(row.prediction) >= 0 &&
        Number(row.prediction) <= 9 &&
        Number.isInteger(row.contractId) &&
        Number.isFinite(row.profit) &&
        typeof row.won === "boolean"
      );
    })
    .slice(-MAX_OBSERVATIONS);
}

function loadLiveTrades(market: ResearchMarket): LiveTradeRecord[] {
  return parseStoredLiveTrades(readStorage<unknown>(`${LIVE_TRADES_KEY}${market}`, []), market);
}

function mergeObservationScores(...collections: ObservationScore[][]): ObservationScore[] {
  const unique = new Map<string, ObservationScore>();
  for (const item of collections.flat()) {
    unique.set(`${item.epoch}:${item.quote ?? item.outcome}`, item);
  }
  return [...unique.values()].sort((a, b) => a.epoch - b.epoch).slice(-MAX_OBSERVATIONS);
}

function mergeLiveTradeRecords(...collections: LiveTradeRecord[][]): LiveTradeRecord[] {
  const unique = new Map<number, LiveTradeRecord>();
  for (const trade of collections.flat()) unique.set(trade.contractId, trade);
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_OBSERVATIONS);
}

function todayTrades(trades: LiveTradeRecord[], now = Date.now()): LiveTradeRecord[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return trades.filter((trade) => trade.timestamp >= start.getTime());
}

function settingsKey(settings: ResearchSettings): string {
  return fingerprint(JSON.stringify(settings));
}

function researchBacktestKey(settings: ResearchSettings, range: BacktestRange): string {
  return fingerprint(`${settingsKey(settings)}:${range}`);
}

function moduleSettingsKey(settings: ResearchSettings, id: ResearchStrategyId): string {
  return id === "multi_model_agreement"
    ? settingsKey(settings)
    : fingerprint(JSON.stringify(settings[id]));
}

function fingerprint(value: string): string {
  let hash = 14695981039346656037n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36);
}

function createPrediction(
  ticks: ResearchTick[],
  settings: ResearchSettings,
  weights: Partial<Record<EnsembleExpertId, number>> | null,
): ObservationPrediction | null {
  const lastTick = ticks.at(-1);
  if (!lastTick) return null;
  const analysis = analyzeResearchHistory(
    ticks.map((tick) => tick.digit),
    settings,
    weights,
  );
  return {
    predictions: RESEARCH_STRATEGIES.map(
      (id) => analysis.modules.find((module) => module.id === id)?.observationDigit ?? null,
    ),
    configKeys: RESEARCH_STRATEGIES.map((id) => moduleSettingsKey(settings, id)),
    basedOnEpoch: lastTick.epoch,
    basedOnQuote: lastTick.quote,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatEpoch(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString();
}

function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(digits)}%`;
}

function downloadCsv(name: string, rows: Array<Array<string | number | null | undefined>>): void {
  if (typeof window === "undefined") return;
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

const cardClass = "rounded-xl border border-slate-200 bg-white shadow-sm";
const mutedLabel = "text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500";
const selectClass =
  "h-9 w-full appearance-none rounded-md border border-slate-300 bg-white px-3 pr-9 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200";
const inputClass =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200";
const buttonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

function StyledSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label={label}
        className={selectClass}
        disabled={disabled}
        value={String(value)}
        onChange={(event) => {
          const selected = options.find((item) => String(item.value) === event.target.value);
          if (selected) onChange(selected.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}

function DigitResearchLab() {
  const [selectedMarket, setSelectedMarket] = useState<ResearchMarket>("R_100");
  const [mode, setMode] = useState<ResearchMode>("research");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [researchStorageReady, setResearchStorageReady] = useState(false);
  const [backtestBusy, setBacktestBusy] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [ticksByMarket, setTicksByMarket] = useState<MarketRecord<ResearchTick[]>>(() =>
    marketRecord(loadTicks),
  );
  const [settingsByMarket, setSettingsByMarket] = useState<MarketRecord<ResearchSettings>>(() =>
    marketRecord(loadSettings),
  );
  const [observationsByMarket, setObservationsByMarket] = useState<
    MarketRecord<ObservationScore[]>
  >(() => marketRecord(loadObservations));
  const [backtestsByMarket, setBacktestsByMarket] = useState<MarketRecord<SavedBacktest | null>>(
    () => marketRecord(loadBacktest),
  );
  const [backtestRanges, setBacktestRanges] = useState<MarketRecord<BacktestRange>>(() =>
    marketRecord(loadBacktestRange),
  );
  const [comparisonStrategy, setComparisonStrategy] =
    useState<ResearchStrategyId>("transition_matrix");
  const [livePermissionsByMarket, setLivePermissionsByMarket] = useState(() =>
    marketRecord(loadLivePermissions),
  );
  const [liveRiskByMarket, setLiveRiskByMarket] = useState<MarketRecord<LiveRiskSettings>>(() =>
    marketRecord(loadLiveRisk),
  );
  const [liveTradesByMarket, setLiveTradesByMarket] = useState<MarketRecord<LiveTradeRecord[]>>(
    () => marketRecord(loadLiveTrades),
  );
  const [liveStrategy, setLiveStrategy] = useState<ResearchStrategyId>("transition_matrix");
  const [liveAccount, setLiveAccount] = useState<DerivAccount | null>(null);
  const [liveBalance, setLiveBalance] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [livePause, setLivePause] = useState<LivePause | null>(null);
  const [liveConnection, setLiveConnection] = useState<"offline" | "connecting" | "ready">(
    "offline",
  );
  const [weightsByMarket, setWeightsByMarket] = useState<
    MarketRecord<Partial<Record<EnsembleExpertId, number>> | null>
  >(() =>
    marketRecord((market) => {
      const saved = loadBacktest(market);
      return saved?.settingsKey ===
        researchBacktestKey(loadSettings(market), loadBacktestRange(market))
        ? saved.result.ensembleWeights
        : null;
    }),
  );
  const [feedByMarket, setFeedByMarket] = useState<MarketRecord<FeedInfo>>(() =>
    marketRecord((market) => ({
      historyLoaded: loadTicks(market).length > 0,
      historyError: null,
      lastLiveAt: null,
      liveTicks: 0,
    })),
  );

  const ticksRef = useRef(ticksByMarket);
  const settingsRef = useRef(settingsByMarket);
  const observationsRef = useRef(observationsByMarket);
  const weightsRef = useRef(weightsByMarket);
  const modeRef = useRef(mode);
  const livePermissionsRef = useRef(livePermissionsByMarket);
  const liveRiskRef = useRef(liveRiskByMarket);
  const liveTradesRef = useRef(liveTradesByMarket);
  const liveStrategyRef = useRef(liveStrategy);
  const liveSessionRef = useRef<DerivTradingSession | null>(null);
  const liveAccountRef = useRef<DerivAccount | null>(null);
  const liveBalanceUnsubscribeRef = useRef<(() => void) | null>(null);
  const liveAttemptRef = useRef(false);
  const queuedLiveAttemptRef = useRef<{
    market: ResearchMarket;
    tick: ResearchTick;
    prediction: ObservationPrediction;
  } | null>(null);
  const tryLiveTradeRef = useRef<
    (market: ResearchMarket, tick: ResearchTick, prediction: ObservationPrediction) => void
  >(() => {});
  const stopLiveRef = useRef<(reason: string, paused: boolean) => void>(() => {});
  const pendingRef = useRef<Partial<Record<ResearchMarket, ObservationPrediction>>>({});
  const socketRef = useRef<DerivWS | null>(null);
  const backtestWorkerRef = useRef<Worker | null>(null);
  const statusRef = useRef<ConnectionState>("connecting");
  const historyInFlightRef = useRef(false);
  const researchWriteTimersRef = useRef(new Map<string, number>());
  const pendingResearchWritesRef = useRef(new Map<string, unknown>());
  const liveTickHandlerRef = useRef<(market: ResearchMarket, tick: ResearchTick) => void>(() => {});
  const historyHandlerRef = useRef<() => Promise<void>>(async () => {});

  ticksRef.current = ticksByMarket;
  settingsRef.current = settingsByMarket;
  observationsRef.current = observationsByMarket;
  weightsRef.current = weightsByMarket;
  modeRef.current = mode;
  livePermissionsRef.current = livePermissionsByMarket;
  liveRiskRef.current = liveRiskByMarket;
  liveTradesRef.current = liveTradesByMarket;
  liveStrategyRef.current = liveStrategy;

  const persistResearchValue = useCallback((key: string, value: unknown) => {
    pendingResearchWritesRef.current.set(key, value);
    const oldTimer = researchWriteTimersRef.current.get(key);
    if (oldTimer !== undefined) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
      researchWriteTimersRef.current.delete(key);
      const latest = pendingResearchWritesRef.current.get(key);
      pendingResearchWritesRef.current.delete(key);
      if (latest !== undefined) {
        void writeResearchValue(key, latest).then((saved) => {
          if (!saved) setStorageWarning(true);
        });
      }
    }, 500);
    researchWriteTimersRef.current.set(key, timer);
  }, []);

  const flushPendingResearchWrites = useCallback((showStorageWarning: boolean) => {
    for (const [key, value] of pendingResearchWritesRef.current) {
      const timer = researchWriteTimersRef.current.get(key);
      if (timer !== undefined) window.clearTimeout(timer);
      researchWriteTimersRef.current.delete(key);
      void writeResearchValue(key, value).then((saved) => {
        if (!saved && showStorageWarning) setStorageWarning(true);
      });
    }
    pendingResearchWritesRef.current.clear();
  }, []);

  const saveMarketTicks = useCallback(
    (market: ResearchMarket, ticks: ResearchTick[]) => {
      const compact = ticks.map((tick) => [tick.epoch, tick.quote, tick.digit, tick.source]);
      persistResearchValue(`ticks:${market}`, compact);
    },
    [persistResearchValue],
  );

  const applyLiveTick = useCallback(
    (market: ResearchMarket, tick: ResearchTick) => {
      const current = ticksRef.current[market] ?? [];
      if (current.some((item) => item.epoch === tick.epoch && item.quote === tick.quote)) return;

      if (modeRef.current === "observation" || modeRef.current === "live") {
        const pending = pendingRef.current[market];
        if (
          pending &&
          (tick.epoch > pending.basedOnEpoch ||
            (tick.epoch === pending.basedOnEpoch && tick.quote !== pending.basedOnQuote))
        ) {
          const score: ObservationScore = {
            epoch: tick.epoch,
            outcome: tick.digit,
            quote: tick.quote,
            predictions: pending.predictions,
            configKeys: pending.configKeys,
          };
          const updated = [...(observationsRef.current[market] ?? []), score].slice(
            -MAX_OBSERVATIONS,
          );
          const updatedByMarket = { ...observationsRef.current, [market]: updated };
          observationsRef.current = updatedByMarket;
          setObservationsByMarket(updatedByMarket);
          persistResearchValue(`observations:${market}`, updated);
        }
      }

      const merged = mergeResearchTicks(current, [tick]);
      const updatedTicks = { ...ticksRef.current, [market]: merged };
      ticksRef.current = updatedTicks;
      setTicksByMarket(updatedTicks);
      saveMarketTicks(market, merged);
      setFeedByMarket((previous) => ({
        ...previous,
        [market]: {
          ...previous[market],
          lastLiveAt: Date.now(),
          liveTicks: previous[market].liveTicks + 1,
        },
      }));

      if (modeRef.current === "observation" || modeRef.current === "live") {
        const settings = settingsRef.current[market];
        const prediction = createPrediction(merged, settings, weightsRef.current[market]);
        if (prediction) {
          pendingRef.current[market] = prediction;
          if (modeRef.current === "live") tryLiveTradeRef.current(market, tick, prediction);
        } else delete pendingRef.current[market];
      }
    },
    [persistResearchValue, saveMarketTicks],
  );
  liveTickHandlerRef.current = applyLiveTick;

  const backfillHistory = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket || historyInFlightRef.current || !socket.isOpen()) return;
    historyInFlightRef.current = true;
    setFeedByMarket((previous) =>
      marketRecord((market) => ({ ...previous[market], historyError: null })),
    );
    try {
      for (const [index, market] of RESEARCH_MARKETS.entries()) {
        try {
          const response = await socket.send<Record<string, unknown>>(
            {
              ticks_history: market,
              end: "latest",
              count: RESEARCH_HISTORY_REQUEST_COUNT,
              style: "ticks",
            },
            25_000,
          );
          const incoming = parseResearchHistory(response, market);
          const merged = mergeResearchTicks(ticksRef.current[market] ?? [], incoming);
          const updatedTicks = { ...ticksRef.current, [market]: merged };
          ticksRef.current = updatedTicks;
          setTicksByMarket(updatedTicks);
          saveMarketTicks(market, merged);
          setFeedByMarket((previous) => ({
            ...previous,
            [market]: {
              ...previous[market],
              historyLoaded: incoming.length > 0,
              historyError: incoming.length ? null : "Deriv returned no timestamped tick history.",
            },
          }));
        } catch (error) {
          setFeedByMarket((previous) => ({
            ...previous,
            [market]: {
              ...previous[market],
              historyError: error instanceof Error ? error.message : "History request failed.",
            },
          }));
        }
        if (index < RESEARCH_MARKETS.length - 1) await wait(350);
      }
    } finally {
      historyInFlightRef.current = false;
      if (modeRef.current === "observation") {
        const refreshed: Partial<Record<ResearchMarket, ObservationPrediction>> = {};
        for (const market of RESEARCH_MARKETS) {
          const prediction = createPrediction(
            ticksRef.current[market] ?? [],
            settingsRef.current[market],
            weightsRef.current[market],
          );
          if (prediction) refreshed[market] = prediction;
        }
        pendingRef.current = refreshed;
      }
    }
  }, [saveMarketTicks]);
  historyHandlerRef.current = backfillHistory;

  useEffect(() => {
    let disposed = false;
    const hydrateMarketData = async () => {
      const tickUpdates: Partial<MarketRecord<ResearchTick[]>> = {};
      const observationUpdates: Partial<MarketRecord<ObservationScore[]>> = {};
      const tradeUpdates: Partial<MarketRecord<LiveTradeRecord[]>> = {};
      for (const market of RESEARCH_MARKETS) {
        try {
          const [savedTicks, savedObservations, savedTrades] = await Promise.all([
            readResearchValue<unknown>(`ticks:${market}`),
            readResearchValue<unknown>(`observations:${market}`),
            readResearchValue<unknown>(`liveTrades:${market}`),
          ]);
          const legacyTicks = loadTicks(market);
          const legacyObservations = loadObservations(market);
          const legacyTrades = loadLiveTrades(market);
          const mergedTicks = mergeResearchTicks(
            mergeResearchTicks(ticksRef.current[market] ?? [], legacyTicks),
            parseStoredResearchTicks(savedTicks ?? []),
          );
          const mergedObservations = mergeObservationScores(
            observationsRef.current[market] ?? [],
            legacyObservations,
            parseStoredObservations(savedObservations ?? []),
          );
          const mergedTrades = mergeLiveTradeRecords(
            liveTradesRef.current[market] ?? [],
            legacyTrades,
            parseStoredLiveTrades(savedTrades ?? [], market),
          );
          tickUpdates[market] = mergedTicks;
          observationUpdates[market] = mergedObservations;
          tradeUpdates[market] = mergedTrades;

          const [ticksSaved, observationsSaved, tradesSaved] = await Promise.all([
            mergedTicks.length
              ? writeResearchValue(
                  `ticks:${market}`,
                  mergedTicks.map((tick) => [tick.epoch, tick.quote, tick.digit, tick.source]),
                )
              : Promise.resolve(true),
            mergedObservations.length
              ? writeResearchValue(`observations:${market}`, mergedObservations)
              : Promise.resolve(true),
            mergedTrades.length
              ? writeResearchValue(`liveTrades:${market}`, mergedTrades)
              : Promise.resolve(true),
          ]);
          if (!ticksSaved || !observationsSaved || !tradesSaved) setStorageWarning(true);
          if (ticksSaved)
            window.localStorage.removeItem(`thdpst-digit-research:ticks:v1:${market}`);
          if (observationsSaved) window.localStorage.removeItem(`${OBSERVATIONS_KEY}${market}`);
          if (tradesSaved) window.localStorage.removeItem(`${LIVE_TRADES_KEY}${market}`);
        } catch {
          setStorageWarning(true);
        }
        if (disposed) return;
      }
      if (disposed) return;
      for (const market of RESEARCH_MARKETS) {
        tickUpdates[market] = mergeResearchTicks(
          ticksRef.current[market] ?? [],
          tickUpdates[market] ?? [],
        );
        observationUpdates[market] = mergeObservationScores(
          observationsRef.current[market] ?? [],
          observationUpdates[market] ?? [],
        );
        tradeUpdates[market] = mergeLiveTradeRecords(
          liveTradesRef.current[market] ?? [],
          tradeUpdates[market] ?? [],
        );
      }
      ticksRef.current = { ...ticksRef.current, ...tickUpdates };
      observationsRef.current = { ...observationsRef.current, ...observationUpdates };
      liveTradesRef.current = { ...liveTradesRef.current, ...tradeUpdates };
      setTicksByMarket((previous) => {
        const next = { ...previous };
        for (const market of RESEARCH_MARKETS) {
          const merged = mergeResearchTicks(previous[market] ?? [], tickUpdates[market] ?? []);
          next[market] = merged;
          ticksRef.current[market] = merged;
        }
        return next;
      });
      setObservationsByMarket((previous) => {
        const next = { ...previous };
        for (const market of RESEARCH_MARKETS) {
          const merged = mergeObservationScores(
            previous[market] ?? [],
            observationUpdates[market] ?? [],
          );
          next[market] = merged;
          observationsRef.current[market] = merged;
        }
        return next;
      });
      setLiveTradesByMarket((previous) => {
        const next = { ...previous };
        for (const market of RESEARCH_MARKETS) {
          const merged = mergeLiveTradeRecords(previous[market] ?? [], tradeUpdates[market] ?? []);
          next[market] = merged;
          liveTradesRef.current[market] = merged;
        }
        return next;
      });
      setResearchStorageReady(true);
    };
    const hydration = hydrateMarketData();
    const socket = new DerivWS(undefined, (status) => {
      const previous = statusRef.current;
      statusRef.current = status;
      setConnection(status);
      if (status === "offline") {
        pendingRef.current = {};
        setConnectionError(
          "The public tick connection is reconnecting. Saved ticks and observations remain available.",
        );
        if (modeRef.current === "live") {
          stopLiveRef.current(
            "Public tick feed disconnected. Live mode stopped and requires a manual restart.",
            true,
          );
        }
      }
      if (status === "live") {
        setConnectionError(null);
        if (previous === "offline") window.setTimeout(() => void historyHandlerRef.current(), 300);
      }
    });
    socketRef.current = socket;
    const unregister = socket.registerHandler("tick", (message) => {
      const parsed = parseResearchLiveTick(message);
      if (parsed) liveTickHandlerRef.current(parsed.market, parsed.tick);
    });

    void (async () => {
      try {
        await socket.waitForOpen();
        if (disposed) return;
        await socket.send({ ticks: [...RESEARCH_MARKETS], subscribe: 1 }, 20_000);
        await hydration;
        if (disposed) return;
        await historyHandlerRef.current();
      } catch (error) {
        if (!disposed)
          setConnectionError(
            error instanceof Error ? error.message : "Could not start the Deriv tick feed.",
          );
      }
    })();

    return () => {
      disposed = true;
      flushPendingResearchWrites(false);
      unregister();
      socket.dispose();
      liveBalanceUnsubscribeRef.current?.();
      liveBalanceUnsubscribeRef.current = null;
      liveSessionRef.current?.dispose();
      liveSessionRef.current = null;
      backtestWorkerRef.current?.terminate();
      backtestWorkerRef.current = null;
      socketRef.current = null;
    };
  }, [flushPendingResearchWrites]);

  const analysisByMarket = useMemo(
    () =>
      marketRecord((market) =>
        analyzeResearchHistory(
          (ticksByMarket[market] ?? []).map((tick) => tick.digit),
          settingsByMarket[market],
          weightsByMarket[market],
        ),
      ),
    [ticksByMarket, settingsByMarket, weightsByMarket],
  );

  const selectedTicks = useMemo(
    () => ticksByMarket[selectedMarket] ?? [],
    [ticksByMarket, selectedMarket],
  );
  const currentSettings = settingsByMarket[selectedMarket];
  const currentAnalysis: DigitResearchAnalysis = analysisByMarket[selectedMarket];
  const currentBacktest = backtestsByMarket[selectedMarket];
  const currentBacktestRange = backtestRanges[selectedMarket];
  const backtestIsCurrent =
    currentBacktest?.settingsKey === researchBacktestKey(currentSettings, currentBacktestRange);
  const latestTick = selectedTicks.at(-1);
  const sequences2 = useMemo(
    () =>
      rankDigitSequences(
        selectedTicks.slice(-currentAnalysis.requestedWindow).map((tick) => tick.digit),
        2,
        currentSettings.two_digit_sequence.minimumSamples,
      ),
    [
      selectedTicks,
      currentAnalysis.requestedWindow,
      currentSettings.two_digit_sequence.minimumSamples,
    ],
  );
  const sequences3 = useMemo(
    () =>
      rankDigitSequences(
        selectedTicks.slice(-currentAnalysis.requestedWindow).map((tick) => tick.digit),
        3,
        currentSettings.three_digit_sequence.minimumSamples,
      ),
    [
      selectedTicks,
      currentAnalysis.requestedWindow,
      currentSettings.three_digit_sequence.minimumSamples,
    ],
  );

  const setModuleSetting = (
    id: ResearchStrategyId,
    patch: Partial<ResearchSettings[ResearchStrategyId]>,
  ) => {
    if (modeRef.current === "live") {
      stopLiveRef.current(
        "A strategy setting changed. Live mode stopped and must be restarted after review.",
        true,
      );
    }
    setSettingsByMarket((previous) => {
      const updatedForMarket = {
        ...previous[selectedMarket],
        [id]: { ...previous[selectedMarket][id], ...patch },
      };
      const updated = { ...previous, [selectedMarket]: updatedForMarket };
      settingsRef.current = updated;
      if (!writeStorage(`${SETTINGS_KEY}${selectedMarket}`, updatedForMarket))
        setStorageWarning(true);
      return updated;
    });
    setWeightsByMarket((previous) => {
      const updated = { ...previous, [selectedMarket]: null };
      weightsRef.current = updated;
      return updated;
    });
  };

  const startObservation = () => {
    const nextPending: Partial<Record<ResearchMarket, ObservationPrediction>> = {};
    for (const market of RESEARCH_MARKETS) {
      const prediction = createPrediction(
        ticksRef.current[market] ?? [],
        settingsRef.current[market],
        weightsRef.current[market],
      );
      if (prediction) nextPending[market] = prediction;
    }
    pendingRef.current = nextPending;
    modeRef.current = "observation";
    setMode("observation");
  };

  const stopObservation = () => {
    modeRef.current = "research";
    pendingRef.current = {};
    setMode("research");
  };

  const runBacktest = () => {
    if (backtestBusy) return;
    setBacktestBusy(true);
    setBacktestError(null);
    const market = selectedMarket;
    const allDigits = (ticksRef.current[market] ?? []).map((tick) => tick.digit);
    const range = backtestRanges[market];
    const digits = range === "all" ? allDigits : allDigits.slice(-range);
    const settings = settingsRef.current[market];
    backtestWorkerRef.current?.terminate();
    const worker = new Worker(
      new URL("../../workers/digit-research-backtest.worker.ts", import.meta.url),
      { type: "module" },
    );
    backtestWorkerRef.current = worker;
    worker.onmessage = (
      event: MessageEvent<{ result?: DigitResearchBacktest; error?: string }>,
    ) => {
      worker.terminate();
      if (backtestWorkerRef.current === worker) backtestWorkerRef.current = null;
      if (event.data.result) {
        const result = event.data.result;
        const saved: SavedBacktest = {
          settingsKey: researchBacktestKey(settings, range),
          ranAt: Date.now(),
          result,
        };
        setBacktestsByMarket((previous) => ({ ...previous, [market]: saved }));
        setWeightsByMarket((previous) => {
          const updated = { ...previous, [market]: result.ensembleWeights };
          weightsRef.current = updated;
          return updated;
        });
        if (!writeStorage(`${BACKTEST_KEY}${market}`, saved)) setStorageWarning(true);
      } else {
        setBacktestError(event.data.error || "Backtest could not complete.");
      }
      setBacktestBusy(false);
    };
    worker.onerror = () => {
      worker.terminate();
      if (backtestWorkerRef.current === worker) backtestWorkerRef.current = null;
      setBacktestError(
        "The walk-forward worker stopped unexpectedly. Try again with the saved tick history.",
      );
      setBacktestBusy(false);
    };
    worker.postMessage({ digits, settings });
  };

  const exportTicks = () =>
    downloadCsv(`${selectedMarket}-digit-ticks.csv`, [
      ["Market", "Epoch", "Local time", "Quote", "Last digit", "Source"],
      ...selectedTicks.map((tick) => [
        selectedMarket,
        tick.epoch,
        formatEpoch(tick.epoch),
        tick.quote,
        tick.digit,
        tick.source,
      ]),
    ]);

  const exportObservations = () =>
    downloadCsv(`${selectedMarket}-digit-observations.csv`, [
      [
        "Market",
        "Epoch",
        "Local time",
        "Actual next digit",
        ...RESEARCH_STRATEGIES.map((id) => `${MODULE_LABELS[id]} prediction`),
      ],
      ...(observationsByMarket[selectedMarket] ?? []).map((item) => [
        selectedMarket,
        item.epoch,
        formatEpoch(item.epoch),
        item.outcome,
        ...item.predictions,
      ]),
    ]);

  const exportBacktest = () => {
    const result = currentBacktest?.result;
    if (!result) return;
    downloadCsv(`${selectedMarket}-walk-forward-backtest.csv`, [
      [
        "Strategy",
        "Status",
        "Development predictions",
        "Development accuracy",
        "Validation predictions",
        "Validation accuracy",
        "Validation 95% CI low",
        "Validation adjusted p",
        "Final predictions",
        "Final accuracy",
        "Final 95% CI low",
        "Final adjusted p",
        "Max final losing streak",
        "Payout adjusted EV",
      ],
      ...result.models.map((model) => [
        MODULE_LABELS[model.id],
        model.status,
        model.development.predictions,
        model.development.accuracy,
        model.validation.predictions,
        model.validation.accuracy,
        model.validation.interval?.lower,
        model.validation.adjustedPValue,
        model.finalTest.predictions,
        model.finalTest.accuracy,
        model.finalTest.interval?.lower,
        model.finalTest.adjustedPValue,
        model.finalTest.maxLosingStreak,
        model.expectedValue,
      ]),
    ]);
  };

  const scoredByModule = (id: ResearchStrategyId) => {
    const index = MODULE_INDEX.get(id) ?? -1;
    const configKey = moduleSettingsKey(currentSettings, id);
    const scored = (observationsByMarket[selectedMarket] ?? []).filter(
      (item) => item.configKeys[index] === configKey && Number.isInteger(item.predictions[index]),
    );
    const correct = scored.filter((item) => item.predictions[index] === item.outcome).length;
    return {
      scored: scored.length,
      correct,
      accuracy: scored.length ? correct / scored.length : null,
    };
  };

  const comparedMarketMetrics = (market: ResearchMarket, id: ResearchStrategyId) => {
    const index = MODULE_INDEX.get(id) ?? -1;
    const configKey = moduleSettingsKey(settingsByMarket[market], id);
    const scored = (observationsByMarket[market] ?? []).filter(
      (item) => item.configKeys[index] === configKey && Number.isInteger(item.predictions[index]),
    );
    const correct = scored.filter((item) => item.predictions[index] === item.outcome).length;
    const accuracy = scored.length ? correct / scored.length : null;
    const validation = backtestsByMarket[market]?.result.models.find((model) => model.id === id);
    return {
      scored: scored.length,
      correct,
      accuracy,
      interval: wilsonInterval(correct, scored.length),
      validation,
    };
  };

  const clearSelectedMarketResearch = () => {
    if (
      !window.confirm(
        `Clear saved ticks, observation scores and backtest results for ${getMarketConfig(selectedMarket).displayName}? Settings will be kept.`,
      )
    )
      return;
    const market = selectedMarket;
    for (const key of [`ticks:${market}`, `observations:${market}`]) {
      const timer = researchWriteTimersRef.current.get(key);
      if (timer !== undefined) window.clearTimeout(timer);
      researchWriteTimersRef.current.delete(key);
      pendingResearchWritesRef.current.delete(key);
      void deleteResearchValue(key);
    }
    window.localStorage.removeItem(`thdpst-digit-research:ticks:v1:${market}`);
    window.localStorage.removeItem(`${OBSERVATIONS_KEY}${market}`);
    window.localStorage.removeItem(`${BACKTEST_KEY}${market}`);
    const nextTicks = { ...ticksRef.current, [market]: [] };
    const nextObservations = { ...observationsRef.current, [market]: [] };
    ticksRef.current = nextTicks;
    observationsRef.current = nextObservations;
    setTicksByMarket(nextTicks);
    setObservationsByMarket(nextObservations);
    setBacktestsByMarket((previous) => ({ ...previous, [market]: null }));
    setWeightsByMarket((previous) => {
      const updated = { ...previous, [market]: null };
      weightsRef.current = updated;
      return updated;
    });
    delete pendingRef.current[market];
    setFeedByMarket((previous) => ({
      ...previous,
      [market]: { ...previous[market], historyLoaded: false, historyError: null },
    }));
  };

  const setLivePermission = useCallback(
    (id: ResearchStrategyId, enabled: boolean) => {
      setLivePermissionsByMarket((previous) => {
        const updatedForMarket = { ...previous[selectedMarket], [id]: enabled };
        const updated = { ...previous, [selectedMarket]: updatedForMarket };
        livePermissionsRef.current = updated;
        if (!writeStorage(`${LIVE_PERMISSION_KEY}${selectedMarket}`, updatedForMarket))
          setStorageWarning(true);
        return updated;
      });
    },
    [selectedMarket],
  );

  const updateLiveRisk = (patch: Partial<LiveRiskSettings>) => {
    setLiveRiskByMarket((previous) => {
      const updatedForMarket = { ...previous[selectedMarket], ...patch };
      const updated = { ...previous, [selectedMarket]: updatedForMarket };
      liveRiskRef.current = updated;
      if (!writeStorage(`${LIVE_RISK_KEY}${selectedMarket}`, updatedForMarket))
        setStorageWarning(true);
      return updated;
    });
  };

  const stopLive = (reason: string, paused: boolean) => {
    modeRef.current = "observation";
    pendingRef.current = {};
    setMode("observation");
    setLiveError(reason);
    setLiveConnection("offline");
    if (paused) setLivePause({ market: selectedMarket, reason, timestamp: Date.now() });
    if (!liveAttemptRef.current) {
      liveBalanceUnsubscribeRef.current?.();
      liveBalanceUnsubscribeRef.current = null;
      liveSessionRef.current?.dispose();
      liveSessionRef.current = null;
    }
  };
  stopLiveRef.current = stopLive;

  const startLive = async () => {
    const market = selectedMarket;
    const strategy = liveStrategy;
    const strategyIndex = MODULE_INDEX.get(strategy) ?? -1;
    const validation = currentBacktest?.result.models.find((model) => model.id === strategy);
    const risk = liveRiskByMarket[market];
    if (!researchStorageReady) {
      setLiveError(
        "Loading this market's saved ticks and trade history. Try Live mode again when loading finishes.",
      );
      return;
    }
    if (!backtestIsCurrent || validation?.status !== "validated" || validation.descriptiveOnly) {
      setLiveError(
        "Run a current 60 / 20 / 20 test and require this strategy to pass both holdout checks before live trading.",
      );
      return;
    }
    if (!livePermissionsByMarket[market][strategy]) {
      setLiveError(
        "Enable this strategy's Live permission first. New strategies start with trading disabled.",
      );
      return;
    }
    if (strategyIndex < 0 || risk.stake <= 0 || risk.testingBalance <= 0) {
      setLiveError("Choose a valid strategy, fixed stake, and testing balance.");
      return;
    }
    if (!hasUsableDerivAuthorization()) {
      setLiveError("Connect a Deriv account with trading permission before starting Live mode.");
      return;
    }
    const accountId = getActiveAccountId();
    const account = getStoredAccounts().find(
      (item) => item.account_id.toUpperCase() === String(accountId || "").toUpperCase(),
    );
    if (!account) {
      setLiveError(
        "No active Deriv account is saved. Return to the trading dashboard and connect an account first.",
      );
      return;
    }
    if (modeRef.current === "live" || liveSessionRef.current) {
      setLiveError("A live session is already running or settling a contract.");
      return;
    }
    setLiveError(null);
    setLivePause(null);
    setLiveAccount(account);
    setLiveBalance(null);
    setLiveConnection("connecting");
    const session = new DerivTradingSession();
    liveSessionRef.current = session;
    liveBalanceUnsubscribeRef.current?.();
    liveBalanceUnsubscribeRef.current = session.onBalance((loginid, balance) => {
      if (loginid.toUpperCase() === account.account_id.toUpperCase()) setLiveBalance(balance);
    });
    const unsubscribe = session.onStatus((status, detail) => {
      if (status === "ready") {
        setLiveConnection("ready");
      } else if (status === "connecting") {
        setLiveConnection("connecting");
      } else if (status === "offline" || status === "error") {
        if (modeRef.current === "live") {
          stopLiveRef.current(
            detail || "Authorized Deriv connection lost. Live mode stopped.",
            true,
          );
        } else {
          setLiveConnection("offline");
        }
      }
    });
    try {
      const connected = await session.connect(account);
      if (!connected || !session.isReady())
        throw new Error("Could not establish the authorized Deriv trading connection.");
      if (liveSessionRef.current !== session) return;
      const currentTick = ticksRef.current[market]?.at(-1);
      if (
        statusRef.current !== "live" ||
        !currentTick ||
        Date.now() / 1000 - currentTick.epoch > 30
      )
        throw new Error(
          "Live market feed is not current. Wait for a fresh Deriv tick, then start again.",
        );
      liveAccountRef.current = account;
      modeRef.current = "live";
      setMode("live");
      setLiveConnection("ready");
      setLiveBalance(session.getLastBalance());
      setLiveError(
        "Live mode is armed. A fresh candidate will be submitted only if its one-tick proposal remains current and passes the full risk gate.",
      );
    } catch (error) {
      unsubscribe();
      session.dispose();
      if (liveSessionRef.current === session) liveSessionRef.current = null;
      setLiveConnection("offline");
      setLiveError(error instanceof Error ? error.message : "Could not start Live mode.");
      liveBalanceUnsubscribeRef.current?.();
      liveBalanceUnsubscribeRef.current = null;
    }
  };

  const tryLiveTrade = useCallback(
    (market: ResearchMarket, signalTick: ResearchTick, prediction: ObservationPrediction) => {
      if (modeRef.current !== "live") return;
      if (market !== selectedMarket) return;
      if (liveAttemptRef.current) {
        queuedLiveAttemptRef.current = { market, tick: signalTick, prediction };
        return;
      }
      const strategy = liveStrategyRef.current;
      const index = MODULE_INDEX.get(strategy) ?? -1;
      const digit = prediction.predictions[index];
      const session = liveSessionRef.current;
      const settings = settingsRef.current[market];
      const backtest = backtestsByMarket[market];
      const range = backtestRanges[market];
      const risk = liveRiskRef.current[market];
      const permissions = livePermissionsRef.current[market];
      const validation = backtest?.result.models.find((model) => model.id === strategy);
      const modelConfig = settings[strategy];
      if (typeof digit !== "number" || !Number.isInteger(digit) || !session?.isReady()) return;
      if (
        !permissions[strategy] ||
        !modelConfig.enabled ||
        !backtest ||
        backtest.settingsKey !== researchBacktestKey(settings, range) ||
        validation?.status !== "validated" ||
        !validation.finalTest.interval
      ) {
        stopLiveRef.current(
          "Live signal rejected because its current setting or holdout validation is no longer eligible.",
          true,
        );
        return;
      }

      liveAttemptRef.current = true;
      const daily = todayTrades(liveTradesRef.current[market] ?? []);
      const dailyLoss = daily.reduce((sum, trade) => sum + Math.max(0, -trade.profit), 0);
      let consecutiveLosses = 0;
      for (const trade of [...(liveTradesRef.current[market] ?? [])].reverse()) {
        if (trade.won) break;
        consecutiveLosses++;
      }
      const quoteAtSignal = signalTick.quote;
      const account = liveAccountRef.current;

      void session
        .buyDigitMatch({
          stake: risk.stake,
          barrierDigit: digit,
          currency: account?.currency ?? "USD",
          symbol: market,
          beforePurchase: ({ ask, payout }) => {
            const latestTick = ticksRef.current[market]?.at(-1);
            if (
              modeRef.current !== "live" ||
              !latestTick ||
              latestTick.epoch !== signalTick.epoch ||
              latestTick.quote !== signalTick.quote
            )
              return false;

            const liveAssessment = assessDigitMatchTrade({
              validated: validation.status === "validated",
              estimate: validation.finalTest.accuracy ?? 0,
              lowerConfidenceBound: validation.finalTest.interval?.lower ?? 0,
              minimumEstimate: modelConfig.minimumConfidence / 100,
              stake: risk.stake,
              proposalAsk: ask,
              proposalPayout: payout,
              balance: session.getLastBalance() ?? 0,
              dailyTrades: daily.length,
              dailyLoss,
              consecutiveLosses,
              openContracts: 0,
              testingBalance: risk.testingBalance,
              maxDailyTrades: risk.maxDailyTrades,
              maxDailyLossPercent: risk.maxDailyLossPercent,
              maxConsecutiveLosses: risk.maxConsecutiveLosses,
              minimumExpectedValue: risk.stake * (risk.minimumExpectedValueMarginPercent / 100),
            });
            if (!liveAssessment.eligible) {
              stopLiveRef.current(liveAssessment.reason, true);
              return false;
            }
            return true;
          },
        })
        .then((result: ContractResult) => {
          const record: LiveTradeRecord = {
            market,
            strategy,
            timestamp: Date.now(),
            prediction: digit,
            quoteAtSignal,
            quoteAtPurchase: quoteAtSignal,
            contractId: result.contractId,
            won: result.won,
            profit: result.profit,
            payout: result.payout,
            buyPrice: result.buyPrice,
            exitDigit: result.exitDigit ?? null,
          };
          const trades = [...(liveTradesRef.current[market] ?? []), record].slice(
            -MAX_OBSERVATIONS,
          );
          const updated = { ...liveTradesRef.current, [market]: trades };
          liveTradesRef.current = updated;
          setLiveTradesByMarket(updated);
          persistResearchValue(`liveTrades:${market}`, trades);
          const today = todayTrades(trades);
          const lossTotal = today.reduce((sum, trade) => sum + Math.max(0, -trade.profit), 0);
          let lossRun = 0;
          for (const trade of [...trades].reverse()) {
            if (trade.won) break;
            lossRun++;
          }
          if (lossTotal >= risk.testingBalance * (risk.maxDailyLossPercent / 100)) {
            stopLiveRef.current(
              `Daily loss stop reached (${lossTotal.toFixed(2)}). Manual restart required.`,
              true,
            );
          } else if (today.length >= risk.maxDailyTrades) {
            stopLiveRef.current(
              `Daily trade limit reached (${today.length}). Manual restart required.`,
              true,
            );
          } else if (lossRun >= risk.maxConsecutiveLosses) {
            stopLiveRef.current(
              `Consecutive-loss stop reached (${lossRun}). Manual restart required.`,
              true,
            );
          } else {
            const configKey = moduleSettingsKey(settings, strategy);
            const scored = (observationsRef.current[market] ?? [])
              .filter(
                (item) =>
                  item.configKeys[index] === configKey && Number.isInteger(item.predictions[index]),
              )
              .slice(-100);
            const observedCorrect = scored.filter(
              (item) => item.predictions[index] === item.outcome,
            ).length;
            const observedInterval = wilsonInterval(observedCorrect, scored.length);
            if (scored.length >= 100 && (observedInterval?.lower ?? 0) <= 0.1) {
              setLivePermission(strategy, false);
              stopLiveRef.current(
                "Observation accuracy deteriorated below the 10% baseline confidence bound. Strategy suspended; manual re-enable and restart required.",
                true,
              );
            }
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Live trade failed.";
          if (modeRef.current === "live" && !message.includes("pre-purchase risk gate")) {
            stopLiveRef.current(message, true);
          }
        })
        .finally(() => {
          liveAttemptRef.current = false;
          const queued = queuedLiveAttemptRef.current;
          queuedLiveAttemptRef.current = null;
          if (modeRef.current !== "live") {
            liveBalanceUnsubscribeRef.current?.();
            liveBalanceUnsubscribeRef.current = null;
            liveSessionRef.current?.dispose();
            liveSessionRef.current = null;
          } else if (queued) {
            window.setTimeout(
              () => tryLiveTradeRef.current(queued.market, queued.tick, queued.prediction),
              0,
            );
          }
        });
    },
    [backtestsByMarket, backtestRanges, persistResearchValue, selectedMarket, setLivePermission],
  );
  tryLiveTradeRef.current = tryLiveTrade;

  const stopLiveManually = () => stopLive("Live mode stopped by user.", false);

  const activePending =
    mode === "observation" || mode === "live" ? pendingRef.current[selectedMarket] : null;
  const liveValidation = currentBacktest?.result.models.find((model) => model.id === liveStrategy);
  const liveEligible =
    backtestIsCurrent && liveValidation?.status === "validated" && !liveValidation.descriptiveOnly;
  const livePermissionEnabled = livePermissionsByMarket[selectedMarket][liveStrategy];
  const liveTodayTrades = todayTrades(liveTradesByMarket[selectedMarket] ?? []);
  const liveTodayProfit = liveTodayTrades.reduce((sum, trade) => sum + trade.profit, 0);
  const liveTodayLoss = liveTodayTrades.reduce((sum, trade) => sum + Math.max(0, -trade.profit), 0);
  const liveTradingStrategies = RESEARCH_STRATEGIES.filter(
    (id) =>
      id !== "rolling_frequency" &&
      id !== "mad" &&
      id !== "least_appearing" &&
      id !== "edge_validation",
  );
  const canStartLive =
    researchStorageReady &&
    connection === "live" &&
    Boolean(latestTick) &&
    Date.now() / 1000 - (latestTick?.epoch ?? 0) <= 30 &&
    liveEligible &&
    livePermissionEnabled &&
    liveConnection !== "connecting" &&
    mode !== "live";

  return (
    <main className="min-h-screen bg-[#f4f6f8] pb-10 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <a
              href="/trade"
              aria-label="Return to trading dashboard"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:bg-slate-50"
            >
              <ArrowLeft className="h-4 w-4" />
            </a>
            <img
              src="/app-icon.png"
              alt="ThDpst Matches"
              className="h-7 w-7 rounded-md object-cover"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-sm font-bold uppercase tracking-wider text-slate-900">
                  ThDpst Matches
                </span>
                <span className="text-xs text-slate-400">/</span>
                <span className="text-sm font-semibold text-slate-700">Digit Intelligence Lab</span>
              </div>
              <p className="text-xs text-slate-500">
                Research, live observation, and explicitly enabled gated trading
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold">
            {connection === "live" ? (
              <Wifi className="h-3.5 w-3.5 text-emerald-600" />
            ) : connection === "offline" ? (
              <WifiOff className="h-3.5 w-3.5 text-amber-600" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-500" />
            )}
            <span
              className={
                connection === "live"
                  ? "text-emerald-700"
                  : connection === "offline"
                    ? "text-amber-700"
                    : "text-slate-600"
              }
            >
              {connection === "live"
                ? "Live market feed"
                : connection === "offline"
                  ? "Reconnecting"
                  : "Connecting"}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1560px] space-y-5 px-4 py-5 sm:px-6 sm:py-7">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              <FlaskConical className="h-3.5 w-3.5" /> Research workspace
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
              Digit Intelligence Lab
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Analyse each standard volatility index independently. Research outputs are candidates,
              not promises of future results.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => void historyHandlerRef.current()}
              disabled={connection !== "live"}
            >
              <RefreshCw className="h-4 w-4" /> Refresh tick history
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={exportTicks}
              disabled={!selectedTicks.length}
            >
              <Download className="h-4 w-4" /> Export ticks
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={exportObservations}
              disabled={!observationsByMarket[selectedMarket]?.length}
            >
              <Download className="h-4 w-4" /> Export observations
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                downloadCsv(`${selectedMarket}-actual-live-trades.csv`, [
                  [
                    "Market",
                    "Strategy",
                    "Timestamp",
                    "Prediction",
                    "Signal quote",
                    "Purchase quote",
                    "Contract ID",
                    "Exit digit",
                    "Won",
                    "Stake",
                    "Payout",
                    "P/L",
                  ],
                  ...(liveTradesByMarket[selectedMarket] ?? []).map((trade) => [
                    trade.market,
                    MODULE_LABELS[trade.strategy],
                    formatEpoch(trade.timestamp / 1000),
                    trade.prediction,
                    trade.quoteAtSignal,
                    trade.quoteAtPurchase,
                    trade.contractId,
                    trade.exitDigit,
                    String(trade.won),
                    trade.buyPrice,
                    trade.payout,
                    trade.profit,
                  ]),
                ])
              }
              disabled={!liveTradesByMarket[selectedMarket]?.length}
            >
              <Download className="h-4 w-4" /> Export contracts
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={clearSelectedMarketResearch}
              disabled={
                !researchStorageReady ||
                (!selectedTicks.length &&
                  !observationsByMarket[selectedMarket]?.length &&
                  !currentBacktest)
              }
            >
              Clear market data
            </button>
          </div>
        </section>

        {(connectionError || storageWarning || backtestError) && (
          <div
            role="status"
            className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {connectionError ||
                backtestError ||
                "The browser could not save all research data. Export it before clearing this browser's storage."}
            </span>
          </div>
        )}

        <section
          className={`${cardClass} grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_minmax(330px,1.5fr)_auto] lg:items-end`}
        >
          <label className="block space-y-1.5">
            <span className={mutedLabel}>Market under review</span>
            <StyledSelect
              label="Research market"
              value={selectedMarket}
              onChange={setSelectedMarket}
              disabled={mode === "live" || liveConnection === "connecting"}
              options={RESEARCH_MARKETS.map((market) => ({
                value: market,
                label: `${getMarketConfig(market).displayName} · ${market}`,
              }))}
            />
          </label>
          <div>
            <span className={`${mutedLabel} mb-1.5 block`}>Mode</span>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1">
              <button
                type="button"
                onClick={stopObservation}
                disabled={mode === "live" || liveConnection === "connecting"}
                className={`rounded-md px-3 py-2 text-xs font-bold transition ${mode === "research" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                Research
              </button>
              <button
                type="button"
                onClick={startObservation}
                disabled={mode === "live" || liveConnection === "connecting"}
                className={`rounded-md px-3 py-2 text-xs font-bold transition ${mode === "observation" ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                Observation
              </button>
              <button
                type="button"
                onClick={() => (mode === "live" ? stopLiveManually() : void startLive())}
                disabled={mode !== "live" && !canStartLive}
                className={`rounded-md px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === "live" ? "bg-rose-600 text-white shadow-sm" : canStartLive ? "bg-emerald-700 text-white shadow-sm hover:bg-emerald-800" : "text-slate-400"}`}
                title={
                  mode === "live"
                    ? "Stop live trading"
                    : "Requires a current validated backtest and explicit per-strategy Live permission."
                }
              >
                {mode === "live"
                  ? "Stop Live"
                  : liveConnection === "connecting"
                    ? "Connecting…"
                    : "Live · gated"}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <label className="w-36 space-y-1">
              <span className="block text-[9px] font-bold uppercase tracking-wide text-slate-500">
                Historical range
              </span>
              <StyledSelect
                label="Backtest historical tick range"
                value={currentBacktestRange}
                onChange={(value) => {
                  setBacktestRanges((previous) => ({ ...previous, [selectedMarket]: value }));
                  if (!writeStorage(`${BACKTEST_RANGE_KEY}${selectedMarket}`, value))
                    setStorageWarning(true);
                }}
                options={[
                  { value: "all", label: `All (${selectedTicks.length.toLocaleString()})` },
                  { value: 1000, label: "Latest 1,000" },
                  { value: 2500, label: "Latest 2,500" },
                  { value: 5000, label: "Latest 5,000" },
                ]}
              />
            </label>
            <button
              type="button"
              onClick={runBacktest}
              disabled={backtestBusy || selectedTicks.length < 250}
              className={`${buttonClass} min-w-[170px] bg-slate-900 text-white hover:border-slate-800 hover:bg-slate-800`}
            >
              {backtestBusy ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <BarChart3 className="h-4 w-4" />
              )}
              {backtestBusy ? "Evaluating holdouts…" : "Run 60 / 20 / 20 test"}
            </button>
            <button
              type="button"
              onClick={exportBacktest}
              className={buttonClass}
              disabled={!currentBacktest}
            >
              <Download className="h-4 w-4" /> Backtest CSV
            </button>
          </div>
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-slate-600" />
                <h2 className="text-sm font-bold text-slate-900">
                  Live strategy and risk controls
                </h2>
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
                Live orders are off by default. Select a validated model, explicitly enable it for
                this market, and review the fixed stake and stop limits. Every order must pass the
                untouched holdout and a fresh Deriv proposal risk check.
              </p>
            </div>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${mode === "live" ? "border-rose-200 bg-rose-50 text-rose-700" : liveEligible ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}
            >
              {mode === "live"
                ? "Live orders armed"
                : liveEligible
                  ? "Holdout passed · permission required"
                  : "Live orders locked"}
            </span>
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.85fr)] sm:p-5">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className={mutedLabel}>Live strategy · {selectedMarket}</span>
                  <StyledSelect
                    label="Strategy allowed for live trading on selected market"
                    value={liveStrategy}
                    disabled={mode === "live" || liveConnection === "connecting"}
                    onChange={(value) => setLiveStrategy(value as ResearchStrategyId)}
                    options={liveTradingStrategies.map((id) => ({
                      value: id,
                      label: MODULE_LABELS[id],
                    }))}
                  />
                </label>
                <div className="flex min-h-14 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <label
                    className={`flex items-start gap-2.5 ${liveEligible && mode !== "live" ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-slate-800 focus:ring-slate-500"
                      checked={livePermissionEnabled}
                      disabled={!liveEligible || mode === "live" || liveConnection === "connecting"}
                      onChange={(event) => setLivePermission(liveStrategy, event.target.checked)}
                    />
                    <span>
                      <span className="block text-xs font-semibold text-slate-800">
                        Allow this strategy to trade
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">
                        Permission is saved separately for each market and strategy.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1">
                  <span className={mutedLabel}>Fixed stake</span>
                  <input
                    className={inputClass}
                    aria-label="Live fixed stake"
                    type="number"
                    min="0.35"
                    max="1000"
                    step="0.01"
                    value={liveRiskByMarket[selectedMarket].stake}
                    disabled={mode === "live"}
                    onChange={(event) =>
                      updateLiveRisk({
                        stake: Math.max(0.35, Math.min(1000, Number(event.target.value) || 0.35)),
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className={mutedLabel}>Daily loss basis</span>
                  <input
                    className={inputClass}
                    aria-label="Daily loss calculation balance"
                    type="number"
                    min="1"
                    step="1"
                    value={liveRiskByMarket[selectedMarket].testingBalance}
                    disabled={mode === "live"}
                    onChange={(event) =>
                      updateLiveRisk({
                        testingBalance: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className={mutedLabel}>Max trades / day</span>
                  <input
                    className={inputClass}
                    aria-label="Maximum live trades per day"
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={liveRiskByMarket[selectedMarket].maxDailyTrades}
                    disabled={mode === "live"}
                    onChange={(event) =>
                      updateLiveRisk({
                        maxDailyTrades: Math.max(
                          1,
                          Math.min(100, Math.floor(Number(event.target.value) || 1)),
                        ),
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className={mutedLabel}>Daily loss stop · max 3%</span>
                  <div className="relative">
                    <input
                      className={`${inputClass} pr-8`}
                      aria-label="Maximum daily loss percent"
                      type="number"
                      min="0.5"
                      max="3"
                      step="0.1"
                      value={liveRiskByMarket[selectedMarket].maxDailyLossPercent}
                      disabled={mode === "live"}
                      onChange={(event) =>
                        updateLiveRisk({
                          maxDailyLossPercent: Math.max(
                            0.5,
                            Math.min(3, Number(event.target.value) || 0.5),
                          ),
                        })
                      }
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                      %
                    </span>
                  </div>
                </label>
                <label className="space-y-1">
                  <span className={mutedLabel}>Stop after loss run</span>
                  <input
                    className={inputClass}
                    aria-label="Maximum consecutive losses"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={liveRiskByMarket[selectedMarket].maxConsecutiveLosses}
                    disabled={mode === "live"}
                    onChange={(event) =>
                      updateLiveRisk({
                        maxConsecutiveLosses: Math.max(
                          1,
                          Math.min(10, Math.floor(Number(event.target.value) || 1)),
                        ),
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className={mutedLabel}>Minimum EV margin · % stake</span>
                  <div className="relative">
                    <input
                      className={`${inputClass} pr-8`}
                      aria-label="Minimum expected value margin percent"
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={liveRiskByMarket[selectedMarket].minimumExpectedValueMarginPercent}
                      disabled={mode === "live"}
                      onChange={(event) =>
                        updateLiveRisk({
                          minimumExpectedValueMarginPercent: Math.max(
                            0,
                            Math.min(100, Number(event.target.value) || 0),
                          ),
                        })
                      }
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                      %
                    </span>
                  </div>
                </label>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <SplitCard
                  title="Validation"
                  value={liveValidation?.status ?? "Not run"}
                  detail={
                    backtestIsCurrent ? "Current settings" : "Run a current 60 / 20 / 20 test"
                  }
                />
                <SplitCard
                  title="Authorized Deriv"
                  value={
                    liveConnection === "ready"
                      ? "Connected"
                      : liveConnection === "connecting"
                        ? "Connecting"
                        : "Not connected"
                  }
                  detail={
                    liveAccount
                      ? `${liveAccount.account_type} · ${liveAccount.account_id}`
                      : "Uses the saved active account"
                  }
                />
                <SplitCard
                  title="Account balance"
                  value={
                    liveBalance === null
                      ? "—"
                      : `${liveAccount?.currency ?? "USD"} ${liveBalance.toFixed(2)}`
                  }
                  detail="Updated by the authorized Deriv balance feed"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {mode === "live" ? (
                  <button
                    type="button"
                    className={`${buttonClass} border-rose-200 bg-rose-600 text-white hover:bg-rose-700`}
                    onClick={stopLiveManually}
                  >
                    <Pause className="h-4 w-4" /> Stop live trading
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${buttonClass} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`}
                    disabled={!canStartLive}
                    onClick={() => void startLive()}
                  >
                    {liveConnection === "connecting" ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {liveConnection === "connecting"
                      ? "Connecting to Deriv…"
                      : "Start live trading"}
                  </button>
                )}
                <span className="text-[10px] text-slate-500">
                  {mode === "live"
                    ? `Running on ${getMarketConfig(selectedMarket).shortName} · one tick · fixed stake · no martingale`
                    : !backtestIsCurrent
                      ? "Run a current backtest first."
                      : !liveEligible
                        ? "This strategy has not passed both corrected holdout periods."
                        : !livePermissionEnabled
                          ? "Enable its per-market permission to continue."
                          : connection !== "live" || !latestTick
                            ? "Waiting for a live market tick."
                            : "A fresh signal still needs a profitable proposal under the conservative confidence bound."}
                </span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <SplitCard
                  title="Today trades"
                  value={`${liveTodayTrades.length} / ${liveRiskByMarket[selectedMarket].maxDailyTrades}`}
                  detail={`${liveTodayTrades.filter((trade) => trade.won).length} wins · ${liveTodayTrades.filter((trade) => !trade.won).length} losses`}
                />
                <SplitCard
                  title="Today P/L"
                  value={`${liveTodayProfit >= 0 ? "+" : ""}${liveTodayProfit.toFixed(2)} ${liveAccount?.currency ?? "USD"}`}
                  detail={`${liveTodayLoss.toFixed(2)} loss against ${((liveRiskByMarket[selectedMarket].testingBalance * liveRiskByMarket[selectedMarket].maxDailyLossPercent) / 100).toFixed(2)} stop`}
                />
                <SplitCard
                  title="Contracts"
                  value={(liveTradesByMarket[selectedMarket] ?? []).length.toLocaleString()}
                  detail="Saved locally for this market"
                />
              </div>
              {liveError && (
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${mode === "live" && !livePause ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
                >
                  <span className="font-semibold">
                    {livePause ? "Live stopped · " : "Live status · "}
                  </span>
                  {liveError}
                </div>
              )}
              {(liveTradesByMarket[selectedMarket] ?? []).length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-[540px] w-full text-left text-[10px]">
                    <thead className="bg-slate-50 uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2.5 py-2">Time</th>
                        <th className="px-2.5 py-2">Signal</th>
                        <th className="px-2.5 py-2">Exit</th>
                        <th className="px-2.5 py-2">Contract</th>
                        <th className="px-2.5 py-2 text-right">P/L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...(liveTradesByMarket[selectedMarket] ?? [])]
                        .reverse()
                        .slice(0, 6)
                        .map((trade) => (
                          <tr key={trade.contractId} className="border-t border-slate-100">
                            <td className="whitespace-nowrap px-2.5 py-2 font-mono text-slate-500">
                              {formatEpoch(trade.timestamp / 1000)}
                            </td>
                            <td className="px-2.5 py-2 font-mono">
                              {trade.prediction} · {trade.quoteAtSignal}
                            </td>
                            <td className="px-2.5 py-2 font-mono">{trade.exitDigit ?? "—"}</td>
                            <td className="px-2.5 py-2">
                              <span
                                className={`rounded px-1.5 py-0.5 font-bold ${trade.won ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}
                              >
                                {trade.won ? "WON" : "LOST"}
                              </span>
                            </td>
                            <td
                              className={`px-2.5 py-2 text-right font-mono font-semibold ${trade.profit >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                            >
                              {trade.profit >= 0 ? "+" : ""}
                              {trade.profit.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[10px] leading-relaxed text-slate-500">
                The live check uses the final holdout's lower confidence bound for expected value.
                It stops before a purchase if the current quote is stale, the proposed stake could
                exceed the remaining daily loss allowance, or the proposal fails any risk check.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Selected market"
            value={getMarketConfig(selectedMarket).displayName}
            detail={`${selectedMarket} · isolated analysis`}
            icon={<Activity className="h-4 w-4" />}
          />
          <MetricCard
            label="Saved ticks"
            value={selectedTicks.length.toLocaleString()}
            detail={`Up to ${RESEARCH_TICK_LIMIT.toLocaleString()} kept locally`}
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <MetricCard
            label="Latest quote / digit"
            value={latestTick ? `${latestTick.quote} / ${latestTick.digit}` : "Waiting for ticks"}
            detail={latestTick ? formatEpoch(latestTick.epoch) : "Waiting for the public feed"}
            icon={<Activity className="h-4 w-4" />}
          />
          <MetricCard
            label="Observation status"
            value={
              mode === "live"
                ? "Live strategy active"
                : mode === "observation"
                  ? "Scoring live ticks"
                  : "Research only"
            }
            detail={
              mode === "live"
                ? `${MODULE_LABELS[liveStrategy]} · ${getMarketConfig(selectedMarket).shortName}`
                : mode === "observation"
                  ? "Each forecast is checked against the next new tick."
                  : "Start observation to score future ticks."
            }
            icon={<Check className="h-4 w-4" />}
          />
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Market feeds</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {RESEARCH_MARKETS.length} separate tick histories. No statistics are shared between
                markets.
              </p>
            </div>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
              {connection === "live" ? "Feed connected" : connection}
            </span>
          </div>
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-5 sm:p-4">
            {RESEARCH_MARKETS.map((market) => {
              const ticks = ticksByMarket[market] ?? [];
              const latest = ticks.at(-1);
              const analysis = analysisByMarket[market];
              const top = analysis.mostAppearing[0];
              const marketFeed = feedByMarket[market];
              return (
                <button
                  key={market}
                  type="button"
                  onClick={() => setSelectedMarket(market)}
                  disabled={mode === "live" || liveConnection === "connecting"}
                  className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed ${selectedMarket === market ? "border-slate-800 bg-slate-50 ring-1 ring-slate-800" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800">
                      {getMarketConfig(market).shortName}
                    </span>
                    <span
                      className={`h-2 w-2 rounded-full ${marketFeed.lastLiveAt ? "bg-emerald-500" : marketFeed.historyLoaded ? "bg-sky-500" : "bg-slate-300"}`}
                    />
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-slate-500">{market}</p>
                  <p className="mt-3 text-lg font-bold tabular-nums text-slate-900">
                    {ticks.length.toLocaleString()}{" "}
                    <span className="text-xs font-medium text-slate-400">ticks</span>
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-500">Latest</span>
                    <span className="font-mono font-semibold">
                      {latest ? `${latest.quote} · ${latest.digit}` : "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-500">Top count</span>
                    <span className="font-semibold">
                      {top ? `${top.digit} · ${top.percentage.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  {marketFeed.historyError && (
                    <p className="mt-2 line-clamp-2 text-[10px] text-amber-700">
                      {marketFeed.historyError}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Index comparison</h2>
              <p className="mt-1 text-xs text-slate-500">
                Observation results use each market's own configuration and ticks. Validation
                columns show that market's saved final chronological holdout.
              </p>
            </div>
            <div className="w-56">
              <StyledSelect
                label="Strategy to compare across indices"
                value={comparisonStrategy}
                onChange={setComparisonStrategy}
                options={RESEARCH_STRATEGIES.filter((id) => id !== "edge_validation").map((id) => ({
                  value: id,
                  label: MODULE_LABELS[id],
                }))}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Index</th>
                  <th className="px-3 py-2.5">Tick sample</th>
                  <th className="px-3 py-2.5">Observed live</th>
                  <th className="px-3 py-2.5">Observed 95% range</th>
                  <th className="px-3 py-2.5">Final holdout</th>
                  <th className="px-3 py-2.5">Holdout status</th>
                  <th className="px-3 py-2.5">Validation EV</th>
                </tr>
              </thead>
              <tbody>
                {RESEARCH_MARKETS.map((market) => {
                  const metrics = comparedMarketMetrics(market, comparisonStrategy);
                  const validation = metrics.validation;
                  return (
                    <tr key={market} className="border-t border-slate-100">
                      <td className="px-3 py-3">
                        <span className="block font-semibold text-slate-800">
                          {getMarketConfig(market).shortName}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">{market}</span>
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {(ticksByMarket[market] ?? []).length.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {metrics.scored
                          ? `${percent(metrics.accuracy)} (${metrics.correct}/${metrics.scored})`
                          : "No scored predictions"}
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {metrics.interval
                          ? `${percent(metrics.interval.lower)} – ${percent(metrics.interval.upper)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {validation
                          ? `${percent(validation.finalTest.accuracy)} (${validation.finalTest.correct}/${validation.finalTest.predictions})`
                          : "Not run"}
                      </td>
                      <td className="px-3 py-3">
                        {validation ? (
                          <span
                            className={`rounded px-2 py-1 text-[10px] font-bold ${validation.status === "validated" ? "bg-emerald-50 text-emerald-700" : validation.status === "insufficient data" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                          >
                            {validation.status}
                          </span>
                        ) : (
                          <span className="text-slate-400">Not tested</span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-slate-500">
                        Unavailable from ticks alone
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            Indices are not ranked by accuracy alone. Final holdout samples are shown beside
            confidence intervals and status; expected value remains unavailable without actual
            historical Deriv proposal prices and payouts.
          </p>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <section className={`${cardClass} p-4 sm:p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Digit frequency and representation
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Latest {currentAnalysis.requestedWindow.toLocaleString()} ticks · frequencies are
                  descriptive, not a promise that an underrepresented digit is due.
                </p>
              </div>
              <span className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600">
                {currentAnalysis.sampleSize.toLocaleString()} /{" "}
                {currentAnalysis.requestedWindow.toLocaleString()}
              </span>
            </div>
            <div className="mt-4 space-y-2.5">
              {currentAnalysis.frequencies.map((row) => (
                <div
                  key={row.digit}
                  className="grid grid-cols-[22px_minmax(80px,1fr)_48px_54px] items-center gap-2 sm:grid-cols-[28px_minmax(120px,1fr)_62px_70px_94px] sm:gap-3"
                >
                  <span className="font-mono text-sm font-bold text-slate-800">{row.digit}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${row.representation === "over" ? "bg-slate-800" : row.representation === "under" ? "bg-slate-400" : "bg-slate-500"}`}
                      style={{ width: `${Math.max(1, row.percentage)}%` }}
                    />
                  </div>
                  <span className="text-right font-mono text-xs tabular-nums text-slate-600">
                    {row.count}
                  </span>
                  <span className="text-right font-mono text-xs tabular-nums text-slate-800">
                    {row.percentage.toFixed(1)}%
                  </span>
                  <span
                    className={`hidden rounded px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wide sm:block ${row.representation === "over" ? "bg-slate-100 text-slate-700" : row.representation === "under" ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-500"}`}
                  >
                    {row.representation}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 overflow-x-auto border-t border-slate-100 pt-3">
              <table className="min-w-[510px] w-full text-left text-[11px]">
                <thead className="text-[9px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2">Digit</th>
                    <th className="py-2">Expected count</th>
                    <th className="py-2">95% Wilson range</th>
                    <th className="py-2">Adjusted p</th>
                  </tr>
                </thead>
                <tbody>
                  {currentAnalysis.frequencies.map((row) => (
                    <tr key={row.digit} className="border-t border-slate-100">
                      <td className="py-1.5 font-mono font-bold">{row.digit}</td>
                      <td className="py-1.5 font-mono">{row.expectedCount.toFixed(1)}</td>
                      <td className="py-1.5 font-mono">
                        {percent(row.interval.lower)} – {percent(row.interval.upper)}
                      </td>
                      <td className="py-1.5 font-mono">
                        {row.adjustedPValue?.toExponential(2) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              P-values use a 10% uniform baseline and a{" "}
              {RESEARCH_MULTIPLE_TEST_FAMILY_SIZE.toLocaleString()}-comparison Bonferroni
              correction. Sequential ticks may be dependent, so these figures are evidence summaries
              rather than guarantees.
            </p>
          </section>

          <section className={`${cardClass} p-4 sm:p-5`}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Absence streaks and current run
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Ticks since each digit last appeared inside the active window.
                </p>
              </div>
              <div className="rounded-lg bg-slate-100 px-3 py-2 text-right">
                <p className={mutedLabel}>Current run</p>
                <p className="font-mono text-sm font-bold">
                  {currentAnalysis.currentRunDigit === null
                    ? "—"
                    : `${currentAnalysis.currentRunDigit} × ${currentAnalysis.currentRunLength}`}
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-2">
              {currentAnalysis.absenceStreaks.map((streak, digit) => (
                <div
                  key={digit}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-center"
                >
                  <p className="font-mono text-xs font-bold text-slate-500">{digit}</p>
                  <p className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-900">
                    {streak}
                  </p>
                  <p className="text-[9px] uppercase tracking-wider text-slate-400">ticks absent</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/70 p-3 text-xs leading-relaxed text-amber-900">
              Streaks are supporting context only. A long absence by itself does not generate an
              entry or a claim that the digit is due.
            </div>
          </section>
        </div>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
            <h2 className="text-sm font-bold text-slate-900">Digit transition matrix</h2>
            <p className="mt-1 text-xs text-slate-500">
              Rows are the previous digit. Cells show the observed next-digit rate and sample count
              from this market only.
            </p>
          </div>
          <div className="overflow-x-auto p-3 sm:p-4">
            <table className="min-w-[800px] w-full border-separate border-spacing-1 text-center text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500">
                    After
                  </th>
                  {Array.from({ length: 10 }, (_, digit) => (
                    <th key={digit} className="min-w-12 px-1 py-2 font-mono text-slate-500">
                      {digit}
                    </th>
                  ))}
                  <th className="min-w-16 px-2 py-2 text-[10px] uppercase tracking-wide text-slate-500">
                    Samples
                  </th>
                </tr>
              </thead>
              <tbody>
                {currentAnalysis.transitionMatrix.map((row) => (
                  <tr key={row.previousDigit}>
                    <th className="rounded bg-slate-100 px-2 py-2 text-left font-mono font-bold text-slate-700">
                      {row.previousDigit}
                    </th>
                    {row.cells.map((cell) => {
                      const shade = Math.min(0.72, Math.max(0.04, cell.probability * 1.6));
                      return (
                        <td
                          key={cell.digit}
                          title={`${cell.count} of ${cell.samples} observations`}
                          className="rounded px-1 py-2 font-mono tabular-nums"
                          style={{
                            backgroundColor: `rgba(15, 23, 42, ${shade})`,
                            color: shade > 0.35 ? "white" : "#334155",
                          }}
                        >
                          {row.samples ? `${(cell.probability * 100).toFixed(0)}%` : "—"}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 font-mono tabular-nums text-slate-500">
                      {row.samples}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-2">
          <SequenceTable
            title="Recurring two-digit contexts"
            description="The next digit observed after each repeated two-digit context."
            sequences={sequences2}
          />
          <SequenceTable
            title="Recurring three-digit contexts"
            description="Only contexts with the configured minimum sample count are listed."
            sequences={sequences3}
          />
        </div>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
            <div>
              <div className="flex items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-slate-600" />
                <h2 className="text-sm font-bold text-slate-900">Analysis modules</h2>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Each module has its own window, sample threshold, minimum estimated probability, and
                target selection. Trading stays off unless a model passes holdouts and is explicitly
                enabled above.
              </p>
            </div>
            {mode === "observation" ? (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
                Observation active
              </span>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                Research mode
              </span>
            )}
          </div>
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 sm:p-4">
            {RESEARCH_STRATEGIES.map((id) => {
              const config = currentSettings[id];
              const module = currentAnalysis.modules.find((item) => item.id === id);
              const score = scoredByModule(id);
              const validationModel = currentBacktest?.result.models.find((item) => item.id === id);
              const pendingIndex = MODULE_INDEX.get(id) ?? -1;
              const pendingDigit = activePending?.predictions[pendingIndex];
              const observedDigit = module?.observationDigit ?? null;
              const displayedProbability =
                observedDigit === null
                  ? (module?.estimatedProbability ?? null)
                  : (module?.probabilities[observedDigit] ?? module?.estimatedProbability ?? null);
              const descriptive =
                id === "rolling_frequency" ||
                id === "mad" ||
                id === "least_appearing" ||
                id === "edge_validation";
              return (
                <article
                  key={id}
                  className={`rounded-lg border p-3.5 transition ${config.enabled ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-75"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex min-w-0 items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(event) =>
                          setModuleSetting(id, { enabled: event.target.checked })
                        }
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-slate-800 focus:ring-slate-500"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-slate-900">
                          {MODULE_LABELS[id]}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">
                          {module?.status}
                        </span>
                      </span>
                    </label>
                    <span
                      className={`shrink-0 rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${module?.descriptiveOnly ? "bg-slate-100 text-slate-500" : "bg-sky-50 text-sky-700"}`}
                    >
                      {module?.descriptiveOnly
                        ? "Diagnostic"
                        : id === "edge_validation"
                          ? "Holdout"
                          : "Predictive"}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        History window
                      </span>
                      <StyledSelect
                        label={`${MODULE_LABELS[id]} history window`}
                        value={config.window}
                        onChange={(value) =>
                          setModuleSetting(id, { window: value as ResearchWindow })
                        }
                        options={RESEARCH_WINDOWS.map((value) => ({
                          value,
                          label: `${value.toLocaleString()} ticks`,
                        }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Min probability
                      </span>
                      <div className="relative">
                        <input
                          className={`${inputClass} pr-8`}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={config.minimumConfidence}
                          onChange={(event) =>
                            setModuleSetting(id, {
                              minimumConfidence: Math.max(
                                0,
                                Math.min(100, Number(event.target.value) || 0),
                              ),
                            })
                          }
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                          %
                        </span>
                      </div>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Min context samples
                      </span>
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={5000}
                        step={1}
                        value={config.minimumSamples}
                        onChange={(event) =>
                          setModuleSetting(id, {
                            minimumSamples: Math.max(
                              1,
                              Math.min(5000, Number(event.target.value) || 1),
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        Target digit
                      </span>
                      <StyledSelect
                        label={`${MODULE_LABELS[id]} target digit`}
                        value={config.target}
                        onChange={(value) => setModuleSetting(id, { target: value })}
                        options={[
                          { value: "auto", label: "Automatic" },
                          ...Array.from({ length: 10 }, (_, digit) => ({
                            value: digit,
                            label: `Digit ${digit}`,
                          })),
                        ]}
                      />
                    </label>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-2.5">
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        {descriptive ? "Research pick" : "Candidate"}
                      </p>
                      <p className="mt-1 font-mono text-lg font-bold text-slate-900">
                        {observedDigit ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        Estimate
                      </p>
                      <p className="mt-1 font-mono text-sm font-bold text-slate-900">
                        {percent(displayedProbability)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        Samples
                      </p>
                      <p className="mt-1 font-mono text-sm font-bold text-slate-900">
                        {(module?.contextSamples ?? 0).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 min-h-8 text-[10px] leading-relaxed text-slate-500">
                    {module?.reason}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-slate-100 bg-white px-2.5 py-2 text-[10px]">
                    <span className="font-semibold text-slate-600">
                      Observation: {score.correct} W · {score.scored - score.correct} L ·{" "}
                      {percent(score.accuracy)}
                    </span>
                    <span className="text-right text-slate-500">
                      Next tick:{" "}
                      {pendingDigit === null || pendingDigit === undefined ? "—" : pendingDigit}
                    </span>
                    <span className="font-semibold text-slate-600">
                      Holdout: {validationModel?.status ?? "Not run"}
                      {validationModel?.finalTest.accuracy !== null &&
                      validationModel?.finalTest.accuracy !== undefined
                        ? ` · ${percent(validationModel.finalTest.accuracy)}`
                        : ""}
                    </span>
                    <span className="text-right text-slate-500">Payout EV: unavailable</span>
                  </div>
                  {id === "multi_model_agreement" && module?.ensembleVotes.length ? (
                    <div className="mt-2 rounded-md bg-slate-50 p-2 text-[9px] leading-relaxed text-slate-600">
                      <span className="font-bold">
                        Supporting models ({module.agreementCount}):{" "}
                      </span>
                      {module.ensembleVotes
                        .map(
                          (vote) =>
                            `${vote.id.replaceAll("_", " ")} → ${vote.digit} (${percent(vote.probability)}, n=${vote.samples})`,
                        )
                        .join(" · ")}
                    </div>
                  ) : null}
                  {descriptive && (
                    <p className="mt-2 rounded bg-slate-100 px-2 py-1 text-[9px] leading-relaxed text-slate-500">
                      Descriptive module. Ranking does not create a predictive signal.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Recent observation outcomes</h2>
              <p className="mt-1 text-xs text-slate-500">
                Predictions are checked against the next new live tick, with each result shown
                below.
              </p>
            </div>
            <span className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600">
              {(observationsByMarket[selectedMarket] ?? []).length.toLocaleString()} scored ticks
            </span>
          </div>
          {(observationsByMarket[selectedMarket] ?? []).length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-semibold text-slate-700">No live outcomes yet</p>
              <p className="mt-1 text-xs text-slate-500">
                Start Observation mode. Each candidate will be checked against the next tick from
                this market.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[980px] w-full text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Live tick time</th>
                    <th className="px-3 py-2">Quote</th>
                    <th className="px-3 py-2">Actual</th>
                    <th className="px-3 py-2">Module predictions · ✓ correct · × miss</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(observationsByMarket[selectedMarket] ?? [])]
                    .reverse()
                    .slice(0, 50)
                    .map((item) => (
                      <tr
                        key={`${item.epoch}:${item.quote ?? item.outcome}`}
                        className="border-t border-slate-100 align-top"
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-slate-600">
                          {formatEpoch(item.epoch)}
                        </td>
                        <td className="px-3 py-2.5 font-mono">{item.quote ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 font-mono font-bold text-white">
                            {item.outcome}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex min-w-[650px] flex-wrap gap-1">
                            {RESEARCH_STRATEGIES.filter((id) => id !== "edge_validation").map(
                              (id) => {
                                const moduleIndex = MODULE_INDEX.get(id) ?? -1;
                                const prediction = item.predictions[moduleIndex];
                                if (!Number.isInteger(prediction)) return null;
                                const correct = prediction === item.outcome;
                                const shortName =
                                  id === "rolling_frequency"
                                    ? "Freq"
                                    : id === "least_appearing"
                                      ? "Least"
                                      : id === "mad"
                                        ? "Most"
                                        : id === "transition_matrix"
                                          ? "Trans"
                                          : id === "markov_chain"
                                            ? "Markov"
                                            : id === "two_digit_sequence"
                                              ? "2-seq"
                                              : id === "three_digit_sequence"
                                                ? "3-seq"
                                                : id === "conditional_probability"
                                                  ? "Cond"
                                                  : "Ensemble";
                                return (
                                  <span
                                    key={id}
                                    title={MODULE_LABELS[id]}
                                    className={`rounded px-1.5 py-1 font-mono text-[10px] font-semibold ${correct ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}
                                  >
                                    {shortName} {prediction}
                                    {correct ? " ✓" : " ×"}
                                  </span>
                                );
                              },
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-slate-600" />
                <h2 className="text-sm font-bold text-slate-900">
                  Chronological walk-forward validation
                </h2>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                60% development · 20% validation · 20% untouched final test · forecasts use earlier
                ticks only.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <span className="rounded bg-slate-100 px-2 py-1">No look-ahead</span>
              <span className="rounded bg-slate-100 px-2 py-1">
                {RESEARCH_MULTIPLE_TEST_FAMILY_SIZE.toLocaleString()} comparisons corrected
              </span>
              <span className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                Profitability unknown
              </span>
            </div>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <SplitCard
              title="Development"
              value={
                currentBacktest
                  ? `${currentBacktest.result.development.startIndex.toLocaleString()}–${currentBacktest.result.development.endIndex.toLocaleString()}`
                  : "Not run"
              }
              detail="Weights and candidates are fit here."
            />
            <SplitCard
              title="Validation"
              value={
                currentBacktest
                  ? `${currentBacktest.result.validation.startIndex.toLocaleString()}–${currentBacktest.result.validation.endIndex.toLocaleString()}`
                  : "Not run"
              }
              detail="Used only to check model selection."
            />
            <SplitCard
              title="Final test"
              value={
                currentBacktest
                  ? `${currentBacktest.result.finalTest.startIndex.toLocaleString()}–${currentBacktest.result.finalTest.endIndex.toLocaleString()}`
                  : "Not run"
              }
              detail="Held out chronologically for final evidence."
            />
          </div>
          <div className="px-4 pb-4 sm:px-5">
            {!currentBacktest ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                <p className="text-sm font-semibold text-slate-700">No walk-forward result yet</p>
                <p className="mt-1 text-xs text-slate-500">
                  Load ticks for this market, then run the 60 / 20 / 20 test.
                </p>
              </div>
            ) : (
              <>
                {!backtestIsCurrent && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Settings changed since this backtest. Run it again before using these results
                    for comparisons.
                  </div>
                )}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span>
                    Ran {formatEpoch(currentBacktest.ranAt / 1000)} ·{" "}
                    {currentBacktest.result.totalTicks.toLocaleString()} ticks ·{" "}
                    {currentBacktest.result.evaluatedTicks.toLocaleString()} outcomes with prior
                    history · final-test baselines: 10% random /{" "}
                    {percent(currentBacktest.result.frequencyBaseline.accuracy)} rolling frequency
                  </span>
                  <span className="font-semibold">Final random baseline: 10%</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-[920px] w-full text-left text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Module</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Validation</th>
                        <th className="px-3 py-2">95% lower bound</th>
                        <th className="px-3 py-2">Adjusted p</th>
                        <th className="px-3 py-2">Final test</th>
                        <th className="px-3 py-2">95% lower bound</th>
                        <th className="px-3 py-2">Adjusted p</th>
                        <th className="px-3 py-2">Max loss run</th>
                        <th className="px-3 py-2">Expected value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentBacktest.result.models.map((model) => (
                        <tr key={model.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-semibold text-slate-800">
                            {MODULE_LABELS[model.id]}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`rounded px-2 py-1 text-[10px] font-bold ${model.status === "validated" ? "bg-emerald-50 text-emerald-700" : model.status === "insufficient data" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                            >
                              {model.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {percent(model.validation.accuracy)} ({model.validation.correct}/
                            {model.validation.predictions})
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {percent(model.validation.interval?.lower)}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {model.validation.adjustedPValue?.toExponential(2) ?? "—"}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {percent(model.finalTest.accuracy)} ({model.finalTest.correct}/
                            {model.finalTest.predictions})
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {percent(model.finalTest.interval?.lower)}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {model.finalTest.adjustedPValue?.toExponential(2) ?? "—"}
                          </td>
                          <td className="px-3 py-2 font-mono">{model.finalTest.maxLosingStreak}</td>
                          <td className="px-3 py-2 font-mono">Unavailable</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-600">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                  <p>
                    {currentBacktest.result.liveTradingStatus} Tick history does not contain
                    historical proposal payouts, so expected value and stake-based drawdown are
                    intentionally not inferred.
                  </p>
                </div>
              </>
            )}
          </div>
        </section>

        <section className={`${cardClass} p-4 sm:p-5`}>
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Risk and execution gate</h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                Live execution requires a current strategy to pass both untouched holdout periods, a
                per-market opt-in, a fresh authorized Deriv connection, and a current Digit Match
                proposal whose expected value remains positive using the final-test lower confidence
                bound. Fixed-stake, account-balance, daily-loss, daily-trade, consecutive-loss, and
                single-open-contract checks are applied before each purchase. A statistically
                unusual tick pattern does not prove a profitable contract.
              </p>
              <p className="mt-2 text-[11px] font-semibold text-amber-800">
                No profit guarantee. Historical tick accuracy is not the same as positive trading
                returns.
              </p>
            </div>
          </div>
        </section>

        <p className="px-1 text-center text-[10px] leading-relaxed text-slate-500">
          Ticks and observation scores are saved locally in this browser. Clear site data and they
          will be removed; use CSV export to keep a copy.
        </p>
      </div>
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className={`${cardClass} p-4`}>
      <div className="flex items-center justify-between gap-2">
        <span className={mutedLabel}>{label}</span>
        <span className="text-slate-400">{icon}</span>
      </div>
      <p className="mt-3 truncate text-lg font-bold text-slate-900">{value}</p>
      <p className="mt-1 truncate text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function SplitCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className={mutedLabel}>{title}</p>
      <p className="mt-2 font-mono text-sm font-bold text-slate-800">{value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{detail}</p>
    </div>
  );
}

function SequenceTable({
  title,
  description,
  sequences,
}: {
  title: string;
  description: string;
  sequences: ReturnType<typeof rankDigitSequences>;
}) {
  return (
    <section className={`${cardClass} overflow-hidden`}>
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      </div>
      {sequences.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Context</th>
                <th className="px-3 py-2">Observed next digit</th>
                <th className="px-3 py-2">Rate</th>
                <th className="px-3 py-2">Samples</th>
                <th className="px-3 py-2">All counts 0–9</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((sequence) => (
                <tr key={sequence.context} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 font-mono text-sm font-bold">{sequence.context}</td>
                  <td className="px-3 py-2.5 font-mono font-bold">{sequence.nextDigit}</td>
                  <td className="px-3 py-2.5 font-mono">
                    {(sequence.probability * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 font-mono">{sequence.samples}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-500">
                    {sequence.counts.join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-7 text-center text-xs text-slate-500">
          No repeated contexts meet the configured minimum sample count yet.
        </div>
      )}
    </section>
  );
}
