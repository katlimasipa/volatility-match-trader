import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  session,
  getDerivClientId,
  derivRedirectUri,
  getDerivWsUrl,
  getAppIdMarkup,
  setAppIdMarkup,
} from "@/lib/deriv-config";
import {
  startDerivAuth,
  getStoredAccounts,
  storeAccounts,
  getActiveAccountId,
  setActiveAccountId,
  getStoredAuthInfo,
  clearAllDerivAuth,
  handleIncomingOAuth,
  authorizeWithToken,
  getManualToken,
  type DerivAccount,
} from "@/lib/deriv-auth";
import { DerivWS } from "@/lib/deriv-ws";
import { DerivTradingSession, isDerivLimitError, type ContractResult } from "@/lib/deriv-trading";
import {
  analyze,
  lastDigit,
  shouldEnter,
  MAX_DIFF,
  WINDOW,
  MARTINGALE_MULTIPLIER,
  calculateMartingaleStake,
  predictNextDigit,
  MARKETS,
  MARKET_LIST,
  getMarketConfig,
  type DigitPrediction,
  type MarketSymbol,
} from "@/lib/matches";
import {
  advanceX2XScanner,
  cancelX2XScanner,
  createX2XScannerState,
  isX2XScannerState,
  lastTwoQuoteDigits,
  rememberUniqueX2XTick,
  runX2XBacktest,
  normalizeX2XOpWaitTicks,
  X2X_MAX_OP_WAIT_TICKS,
  X2X_OP_WINDOW_TICKS,
  type X2XBacktestResult,
  type X2XQuoteDigit,
  type X2XScannerEvent,
  type X2XScannerState,
} from "@/lib/x2x-strategy";
import { startBotKeepalive, stopBotKeepalive, requestScreenWakeLock } from "@/lib/bot-keepalive";
import {
  isNotificationSupported,
  isNotificationEnabled,
  setNotificationEnabled,
  requestNotificationPermission,
  notifyTradeWon,
  notifyTradeLost,
  notifyTakeProfit,
  notifyStopLoss,
  notifyBotStarted,
  notifyBotStopped,
  notifyTradeFailed,
  notifyConnectionLost,
  notifyConnectionRestored,
  isSoundEnabled,
  setSoundEnabled,
  playAlertSound,
  dispatchNotification,
  presentRemoteAlert,
  onInAppAlert,
  initAudioContext,
  isIOSSafariNotPWA,
} from "@/lib/notifications";
import {
  catchUpAlerts,
  connectAlertSync,
  disconnectAlertSync,
  onSyncedAlert,
  publishSyncedAlert,
} from "@/lib/alert-sync";
import { disableWebPush, enableWebPush } from "@/lib/push-client";
import { isRunningStandalone, isIOS, onInstallableChange, triggerInstallPrompt } from "@/lib/pwa";
import { calculateMatchesPayout, DERIV_MATCH_BASE_PAYOUT_RATIO } from "@/lib/payout";

export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({
    meta: [
      { title: "ThDpst Matches // Volatility Trader" },
      {
        name: "description",
        content:
          "Deriv Matches trader for Volatility 75, Volatility 100, Volatility 10, and their 1-second indices.",
      },
    ],
  }),
  component: TradeTerminal,
});

function getDeviceLabel(): string {
  if (isRunningStandalone()) return isIOS() ? "iPhone app" : "installed app";
  return typeof navigator !== "undefined" && /mobile/i.test(navigator.userAgent)
    ? "phone browser"
    : "desktop";
}

interface TradeRow {
  id: number;
  runIndex: number;
  entry: number;
  target: number;
  result: number;
  stake: number;
  pnl: number;
  time: string;
  signalId?: string | undefined;
  contractId?: number | undefined;
}

type X2XSignalStatus =
  | "signal_created"
  | "monitoring"
  | "triggered"
  | "trade_submitted"
  | "settled"
  | "expired"
  | "rejected"
  | "failed"
  | "cancelled";

interface X2XSignalRecord {
  signalId: string;
  pattern: string;
  patternTickIds: string[];
  patternTickTimestamps: string[];
  patternQuotes: Array<number | null>;
  detectedAt: string;
  referencePair: string;
  opTrigger: string | null;
  ldp: number | null;
  contractDuration: 1;
  eligibleTicksElapsed: number;
  eligibleTicksLimit?: number | null;
  status: X2XSignalStatus;
  updatedAt: string;
  cancelledAt?: string | undefined;
  triggerAt?: string | undefined;
  contractId?: number | undefined;
  stake?: number | undefined;
  result?: "won" | "lost" | undefined;
  reason?: string | undefined;
}

interface SavedSession {
  id: string;
  savedAt: string;
  marketSymbol: MarketSymbol;
  trades: TradeRow[];
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  spreadThreshold: number;
  baseStake: number;
  martingaleEnabled: boolean;
  strategyMode?: StrategyMode;
  x2xSignals?: X2XSignalRecord[];
  x2xOpWaitTicks?: number | null;
}

const SESSION_HISTORY_STORAGE_KEY = "thdpst_session_history_v1";
const STRATEGY_MODE_STORAGE_KEY = "thdpst_strategy_mode_v1";
const X2X_SIGNAL_HISTORY_STORAGE_KEY = "thdpst_x2x_signal_history_v1";
const X2X_SCANNER_STORAGE_KEY = "thdpst_x2x_scanner_state_v1";
const X2X_OP_WAIT_TICKS_STORAGE_KEY = "thdpst_x2x_op_wait_ticks_v1";
const X2X_SEEN_TICK_IDS_STORAGE_KEY = "thdpst_x2x_seen_tick_ids_v1";
const MAX_SAVED_SESSIONS = 50;
const MAX_X2X_AUDIT_SIGNALS = 200;
const MAX_X2X_SEEN_TICK_IDS = 256;

type StrategyMode = "matches" | "x2x";

function loadStrategyMode(): StrategyMode {
  if (typeof window === "undefined") return "matches";
  try {
    return localStorage.getItem(STRATEGY_MODE_STORAGE_KEY) === "x2x" ? "x2x" : "matches";
  } catch {
    return "matches";
  }
}

function normalizeDecimalInput(value: string): string {
  return value.replace(",", ".");
}

function isDecimalInput(value: string): boolean {
  return /^\d*(?:[.,]\d*)?$/.test(value);
}

function parseDecimalInput(value: string): number {
  const normalized = normalizeDecimalInput(value);
  if (normalized === "" || normalized === ".") return Number.NaN;
  return Number(normalized);
}

function isTradeRow(value: unknown): value is TradeRow {
  if (typeof value !== "object" || value === null) return false;
  const trade = value as Partial<TradeRow>;
  return (
    typeof trade.id === "number" &&
    Number.isFinite(trade.id) &&
    typeof trade.runIndex === "number" &&
    Number.isFinite(trade.runIndex) &&
    typeof trade.entry === "number" &&
    Number.isFinite(trade.entry) &&
    typeof trade.target === "number" &&
    Number.isFinite(trade.target) &&
    typeof trade.result === "number" &&
    Number.isFinite(trade.result) &&
    typeof trade.stake === "number" &&
    Number.isFinite(trade.stake) &&
    typeof trade.pnl === "number" &&
    Number.isFinite(trade.pnl) &&
    typeof trade.time === "string" &&
    (trade.signalId === undefined || typeof trade.signalId === "string") &&
    (trade.contractId === undefined ||
      (typeof trade.contractId === "number" && Number.isFinite(trade.contractId)))
  );
}

function isSavedSession(value: unknown): value is SavedSession {
  if (typeof value !== "object" || value === null) return false;
  const saved = value as Partial<SavedSession>;
  return (
    typeof saved.id === "string" &&
    typeof saved.savedAt === "string" &&
    Number.isFinite(Date.parse(saved.savedAt)) &&
    typeof saved.marketSymbol === "string" &&
    MARKET_LIST.some((market) => market.id === saved.marketSymbol) &&
    Array.isArray(saved.trades) &&
    saved.trades.every(isTradeRow) &&
    typeof saved.totalPnl === "number" &&
    Number.isFinite(saved.totalPnl) &&
    typeof saved.wins === "number" &&
    Number.isFinite(saved.wins) &&
    typeof saved.losses === "number" &&
    Number.isFinite(saved.losses) &&
    typeof saved.winRate === "number" &&
    Number.isFinite(saved.winRate) &&
    typeof saved.spreadThreshold === "number" &&
    Number.isFinite(saved.spreadThreshold) &&
    typeof saved.baseStake === "number" &&
    Number.isFinite(saved.baseStake) &&
    typeof saved.martingaleEnabled === "boolean" &&
    (saved.strategyMode === undefined ||
      saved.strategyMode === "matches" ||
      saved.strategyMode === "x2x") &&
    (saved.x2xOpWaitTicks === undefined ||
      saved.x2xOpWaitTicks === null ||
      (Number.isInteger(saved.x2xOpWaitTicks) &&
        saved.x2xOpWaitTicks >= 1 &&
        saved.x2xOpWaitTicks <= X2X_MAX_OP_WAIT_TICKS)) &&
    (saved.x2xSignals === undefined ||
      (Array.isArray(saved.x2xSignals) && saved.x2xSignals.every(isX2XSignalRecord)))
  );
}

function loadSavedSessions(): SavedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(SESSION_HISTORY_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isSavedSession).slice(0, MAX_SAVED_SESSIONS) : [];
  } catch {
    return [];
  }
}

function isX2XSignalRecord(value: unknown): value is X2XSignalRecord {
  if (typeof value !== "object" || value === null) return false;
  const signal = value as Partial<X2XSignalRecord>;
  return (
    typeof signal.signalId === "string" &&
    typeof signal.pattern === "string" &&
    Array.isArray(signal.patternTickIds) &&
    signal.patternTickIds.every((id) => typeof id === "string") &&
    Array.isArray(signal.patternTickTimestamps) &&
    signal.patternTickTimestamps.every((timestamp) => typeof timestamp === "string") &&
    Array.isArray(signal.patternQuotes) &&
    signal.patternQuotes.every((quote) => quote === null || typeof quote === "number") &&
    typeof signal.detectedAt === "string" &&
    typeof signal.referencePair === "string" &&
    (signal.opTrigger === null ||
      (typeof signal.opTrigger === "string" && /^\d{2}$/.test(signal.opTrigger))) &&
    (signal.ldp === null ||
      (typeof signal.ldp === "number" &&
        Number.isInteger(signal.ldp) &&
        signal.ldp >= 0 &&
        signal.ldp <= 9)) &&
    signal.contractDuration === 1 &&
    Number.isInteger(signal.eligibleTicksElapsed) &&
    (signal.eligibleTicksLimit === undefined ||
      signal.eligibleTicksLimit === null ||
      (Number.isInteger(signal.eligibleTicksLimit) && signal.eligibleTicksLimit >= 1)) &&
    [
      "signal_created",
      "monitoring",
      "triggered",
      "trade_submitted",
      "settled",
      "expired",
      "rejected",
      "failed",
      "cancelled",
    ].includes(String(signal.status)) &&
    typeof signal.updatedAt === "string" &&
    Number.isFinite(Date.parse(signal.detectedAt)) &&
    Number.isFinite(Date.parse(signal.updatedAt)) &&
    (signal.cancelledAt === undefined ||
      (typeof signal.cancelledAt === "string" &&
        Number.isFinite(Date.parse(signal.cancelledAt)))) &&
    (signal.contractId === undefined ||
      (typeof signal.contractId === "number" && Number.isFinite(signal.contractId))) &&
    (signal.result === undefined || signal.result === "won" || signal.result === "lost")
  );
}

function loadX2XSignalHistory(): X2XSignalRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(X2X_SIGNAL_HISTORY_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter(isX2XSignalRecord).slice(0, MAX_X2X_AUDIT_SIGNALS)
      : [];
  } catch {
    return [];
  }
}

function persistX2XSignalHistory(signals: X2XSignalRecord[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(X2X_SIGNAL_HISTORY_STORAGE_KEY, JSON.stringify(signals));
    return true;
  } catch {
    return false;
  }
}

function loadX2XScannerState(): X2XScannerState {
  if (typeof window === "undefined") return createX2XScannerState();
  try {
    const stored = localStorage.getItem(X2X_SCANNER_STORAGE_KEY);
    if (!stored) return createX2XScannerState();
    const parsed: unknown = JSON.parse(stored);
    return isX2XScannerState(parsed) ? parsed : createX2XScannerState();
  } catch {
    return createX2XScannerState();
  }
}

function loadX2XOpWaitTicks(): number | null {
  if (typeof window === "undefined") return X2X_OP_WINDOW_TICKS;
  try {
    const stored = localStorage.getItem(X2X_OP_WAIT_TICKS_STORAGE_KEY);
    if (stored === null) return X2X_OP_WINDOW_TICKS;
    return normalizeX2XOpWaitTicks(JSON.parse(stored));
  } catch {
    return X2X_OP_WINDOW_TICKS;
  }
}

function formatX2XWaitProgress(elapsed: number, limit: number | null | undefined): string {
  const effectiveLimit = limit === undefined ? X2X_OP_WINDOW_TICKS : limit;
  return effectiveLimit === null
    ? `${elapsed} eligible ticks · no expiry`
    : `${elapsed}/${effectiveLimit} eligible ticks`;
}

function loadX2XSeenTickIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(X2X_SEEN_TICK_IDS_STORAGE_KEY) || "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string").slice(-MAX_X2X_SEEN_TICK_IDS)
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistSavedSessions(sessions: SavedSession[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(SESSION_HISTORY_STORAGE_KEY, JSON.stringify(sessions));
    return true;
  } catch {
    return false;
  }
}

interface PendingTrade {
  runIndex: number;
  entry: number;
  target: number;
  stake: number;
  /** When true, settlement comes from Deriv contract result — not the next local tick. */
  live?: boolean;
  signalId?: string;
}

interface TickItem {
  time: string;
  price: number;
  digit: number;
  predictedDigit?: number | undefined;
  predictionCorrect?: boolean | undefined;
}

interface PredictionStats {
  forecasts: number;
  correct: number;
  recentResults: boolean[];
  currentStreak: number;
  lastResult: boolean | null;
}

function emptyPredictionStats(): PredictionStats {
  return {
    forecasts: 0,
    correct: 0,
    recentResults: [],
    currentStreak: 0,
    lastResult: null,
  };
}

interface BacktestSummary {
  strategyMode: StrategyMode;
  totalTicks: number;
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number | null;
  x2x?: X2XBacktestResult;
}

function TradeTerminal() {
  const navigate = useNavigate();
  const [, setEmail] = useState<string | null>(null);

  // Minimalist theme state (Dark by default, toggles to clean Light)
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("thdpst_theme");
      if (saved === "light" || saved === "dark") return saved;
    }
    return "dark";
  });

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("thdpst_theme", nextTheme);
    }
  };

  const isDark = theme === "dark";

  // Accounts state
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isConnectedToDeriv, setIsConnectedToDeriv] = useState(false);

  // Deriv connection modal (Auth 2.0 PKCE)
  const [showConnectModal, setShowConnectModal] = useState(false);

  // In-app alert banner
  const [inAppAlert, setInAppAlert] = useState<{
    id: number;
    title: string;
    body: string;
    type: string;
  } | null>(null);

  // Mobile settings drawer/modal
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // App ID and configured markup dynamically resolved for this application
  const activeAppId = getDerivClientId();
  const [configuredMarkup, setConfiguredMarkup] = useState<number>(() =>
    getAppIdMarkup(activeAppId),
  );

  // Market Selection state (standard and 1-second Volatility 100 / 75 / 10 indices)
  const [marketSymbol, setMarketSymbol] = useState<MarketSymbol>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("thdpst_market_symbol");
      const savedMarket = MARKET_LIST.find((market) => market.id === saved);
      if (savedMarket) return savedMarket.id;
    }
    return "R_100";
  });
  const [strategyMode, setStrategyMode] = useState<StrategyMode>(loadStrategyMode);
  const startTickRequirement = strategyMode === "x2x" ? 3 : WINDOW;
  const [x2xScannerState, setX2xScannerState] = useState<X2XScannerState>(loadX2XScannerState);
  const x2xScannerRef = useRef<X2XScannerState>(x2xScannerState);
  const currentMarket = getMarketConfig(marketSymbol);
  const [marketPipDecimals, setMarketPipDecimals] = useState(currentMarket.pipDecimals);

  // Derive activeAccount and activeType (case-insensitive — Deriv loginids vary in casing)
  const activeAccount =
    accounts.find((a) => a.account_id.toUpperCase() === String(activeId || "").toUpperCase()) ||
    accounts[0];
  const activeType: "demo" | "real" = activeAccount?.account_type || "demo";

  // Market stream state: strictly chronological ticks and digits
  const [digits, setDigits] = useState<number[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [recentTicks, setRecentTicks] = useState<TickItem[]>([]);
  const [nextPrediction, setNextPrediction] = useState<DigitPrediction | null>(null);
  const [predictionStats, setPredictionStats] = useState<PredictionStats>(emptyPredictionStats);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  // Strategy & Bot configuration (Strictly Matches strategy parameters)
  const [maxDiff, setMaxDiff] = useState<number>(MAX_DIFF);
  const [maxDiffInput, setMaxDiffInput] = useState<string>(String(MAX_DIFF));
  const [x2xOpWaitTicks, setX2xOpWaitTicks] = useState<number | null>(loadX2XOpWaitTicks);
  const [x2xOpWaitTicksInput, setX2xOpWaitTicksInput] = useState<string>(() => {
    const limit = loadX2XOpWaitTicks();
    return limit === null ? "" : String(limit);
  });
  const [reAnalyzeOnLoss, setReAnalyzeOnLoss] = useState(true);
  const [martingaleEnabled, setMartingaleEnabled] = useState(false);
  const [stopOnWin, setStopOnWin] = useState(false); // stop the bot after its first win
  const [stake, setStake] = useState<number>(1);
  const [stakeInput, setStakeInput] = useState<string>("1");
  const [tp, setTp] = useState<number>(50);
  const [tpInput, setTpInput] = useState<string>("50");
  const [sl, setSl] = useState<number>(50);
  const [slInput, setSlInput] = useState<string>("50");
  const [centerTab, setCenterTab] = useState<"trade_log" | "session_history">("trade_log");

  function updateStake(val: number, strVal?: string) {
    setStake(val);
    setStakeInput(strVal !== undefined ? strVal : String(val));
  }

  function updateTp(val: number, strVal?: string) {
    setTp(val);
    setTpInput(strVal !== undefined ? strVal : String(val));
  }

  function updateSl(val: number, strVal?: string) {
    setSl(val);
    setSlInput(strVal !== undefined ? strVal : String(val));
  }

  function updateMaxDiff(val: number, strVal?: string) {
    setMaxDiff(val);
    setMaxDiffInput(strVal !== undefined ? strVal : String(val));
  }

  function updateX2XOpWaitTicks(value: number | null) {
    const normalized = normalizeX2XOpWaitTicks(value);
    setX2xOpWaitTicks(normalized);
    setX2xOpWaitTicksInput(normalized === null ? "" : String(normalized));
    try {
      localStorage.setItem(X2X_OP_WAIT_TICKS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // The current page setting still applies when local storage is unavailable.
    }
  }

  function handleSelectMarket(m: MarketSymbol) {
    if (m === marketSymbol) return;
    if (running) {
      alert("Please stop the bot before switching markets.");
      return;
    }
    setMarketSymbol(m);
    setMarketPipDecimals(MARKETS[m].pipDecimals);
    if (typeof window !== "undefined") {
      localStorage.setItem("thdpst_market_symbol", m);
    }
    digitsRef.current = [];
    x2xTicksRef.current = [];
    predictionRef.current = null;
    setDigits([]);
    setRecentTicks([]);
    setNextPrediction(null);
    setPredictionStats(emptyPredictionStats());
    saveX2XScannerState(createX2XScannerState());
    setPrice(null);
    setBotState("BUFFERING");
    setNote(`Switching to ${MARKETS[m].displayName}. Buffering last 1,000 market ticks...`);
  }

  function handleSelectStrategy(nextStrategy: StrategyMode) {
    if (running) return;
    if (strategyMode === "x2x" && nextStrategy !== "x2x") {
      cancelPendingX2XSignal("X2X strategy disabled by user.");
    }
    setStrategyMode(nextStrategy);
    saveX2XScannerState(createX2XScannerState());
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STRATEGY_MODE_STORAGE_KEY, nextStrategy);
      } catch {
        // Strategy selection still works for this page if storage is unavailable.
      }
    }
    setNote(
      nextStrategy === "x2x"
        ? `X2X Sniper selected on ${currentMarket.displayName}. Live pattern scanning starts when the bot starts.`
        : "Matches strategy selected.",
    );
  }

  // Execution state
  const [running, setRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [x2xSignals, setX2xSignals] = useState<X2XSignalRecord[]>(loadX2XSignalHistory);
  const x2xSignalsRef = useRef<X2XSignalRecord[]>(x2xSignals);
  x2xSignalsRef.current = x2xSignals;
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(loadSavedSessions);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [botState, setBotState] = useState<
    "IDLE" | "BUFFERING" | "ANALYZING" | "WAITING ENTRY" | "IN TRADE" | "LOSS RE-ANALYSIS"
  >("BUFFERING");
  const [note, setNote] = useState("Buffering last 1,000 market ticks before analyzing market...");

  // Backtest / Inspection Modal
  const [backtest, setBacktest] = useState<BacktestSummary | null>(null);
  const [showBacktestModal, setShowBacktestModal] = useState(false);

  // Cross-device notifications, sound & PWA install state
  const [notifsEnabled, setNotifsEnabled] = useState(isNotificationEnabled);
  const [soundEnabled, setSoundEnabledState] = useState(isSoundEnabled);
  const [installable, setInstallable] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showIOSInstallGuide, setShowIOSInstallGuide] = useState(false);
  const [mobileTab, setMobileTab] = useState<"controls" | "market" | "session" | "all">("market");

  // In-app alert listener
  useEffect(() => {
    const unsub = onInAppAlert((alert) => {
      setInAppAlert(alert);
      const timer = setTimeout(() => {
        setInAppAlert((cur) => (cur?.id === alert.id ? null : cur));
      }, 5000);
      return () => clearTimeout(timer);
    });
    return () => unsub();
  }, []);

  // Web Audio Context initialization on first interaction
  useEffect(() => {
    const handleGesture = () => {
      initAudioContext();
    };
    window.addEventListener("touchstart", handleGesture, { once: true, passive: true });
    window.addEventListener("click", handleGesture, { once: true });
    return () => {
      window.removeEventListener("touchstart", handleGesture);
      window.removeEventListener("click", handleGesture);
    };
  }, []);

  useEffect(() => {
    setIsStandalone(isRunningStandalone());
    const unsub = onInstallableChange((canInstall) => setInstallable(canInstall));
    return () => unsub();
  }, []);

  // Cross-device alerts: same Deriv account → Realtime + catch-up + Web Push
  useEffect(() => {
    const accountId = activeAccount?.account_id || getActiveAccountId();
    let cancelled = false;

    void (async () => {
      await connectAlertSync(accountId);
      if (cancelled) return;
      const missed = await catchUpAlerts(accountId);
      if (cancelled) return;
      for (const alert of missed) {
        presentRemoteAlert(alert.title, alert.body, alert.kind, alert.id);
      }
      if (notifsEnabled) {
        await enableWebPush(accountId);
      }
    })();

    const unsub = onSyncedAlert((alert) => {
      presentRemoteAlert(alert.title, alert.body, alert.kind, alert.id);
    });

    return () => {
      cancelled = true;
      unsub();
      void disconnectAlertSync();
    };
  }, [activeAccount?.account_id, notifsEnabled]);

  async function toggleNotifications() {
    initAudioContext();
    if (!notifsEnabled) {
      if (isIOSSafariNotPWA()) {
        setShowIOSInstallGuide(true);
        return;
      }
      const perm = await requestNotificationPermission();
      if (perm === "granted") {
        setNotifsEnabled(true);
        setNotificationEnabled(true);
        const accountId = activeAccount?.account_id || getActiveAccountId();
        void connectAlertSync(accountId);
        const push = await enableWebPush(accountId);
        void dispatchNotification("Notifications Enabled", {
          body: push.ok
            ? "Alerts sync across your devices — including when the app is closed (Web Push)."
            : "Alerts sync on open devices. " +
              (push.error || "Background push will turn on once keys/tables are configured."),
          skipSync: true,
        });
      } else if (perm === "denied") {
        alert(
          "Notifications are blocked in your browser or device settings. Please allow notifications for this site to receive trade alerts.",
        );
      } else if (perm === "unsupported") {
        setShowIOSInstallGuide(true);
      }
    } else {
      setNotificationEnabled(false);
      setNotifsEnabled(false);
      void disableWebPush();
    }
  }

  function toggleSound() {
    initAudioContext();
    const next = !soundEnabled;
    setSoundEnabled(next);
    setSoundEnabledState(next);
    if (next) playAlertSound("win");
  }

  async function handleInstallApp() {
    if (isIOS()) {
      setShowIOSInstallGuide(true);
    } else {
      const outcome = await triggerInstallPrompt();
      if (outcome === "unavailable") {
        setShowIOSInstallGuide(true);
      }
    }
  }

  const pending = useRef<PendingTrade | null>(null);
  const lossStreakRef = useRef(0);
  const pendingSetAt = useRef<number>(0); // timestamp when pending was set, for stuck-trade safety
  const digitsRef = useRef<number[]>([]); // synchronous market digits buffer, avoids state batching drops
  const x2xTicksRef = useRef<X2XQuoteDigit[]>([]);
  const seenX2XTickIdsRef = useRef<Set<string>>(loadX2XSeenTickIds());
  const predictionRef = useRef<DigitPrediction | null>(null);
  const lossCooldownTicks = useRef(0);
  const lastTickAt = useRef<number>(Date.now());
  const keepaliveCleanupRef = useRef<(() => void) | null>(null);
  const wsRef = useRef<DerivWS | null>(null);
  const tradingRef = useRef<DerivTradingSession | null>(null);
  const connectionLostAlertedRef = useRef(false);
  const handleTickEventRef = useRef(handleTickEvent);
  handleTickEventRef.current = handleTickEvent;
  const [tradingReady, setTradingReady] = useState(false);
  const [tradingStatusNote, setTradingStatusNote] = useState<string | null>(null);

  const stateRef = useRef({
    running,
    stake,
    tp,
    sl,
    runCount,
    trades,
    botState,
    reAnalyzeOnLoss,
    martingaleEnabled,
    activeId,
    maxDiff,
    x2xOpWaitTicks,
    configuredMarkup,
    stopOnWin,
    marketSymbol,
    strategyMode,
  });
  stateRef.current = {
    running,
    stake,
    tp,
    sl,
    runCount,
    trades,
    botState,
    reAnalyzeOnLoss,
    martingaleEnabled,
    activeId,
    maxDiff,
    x2xOpWaitTicks,
    configuredMarkup,
    stopOnWin,
    marketSymbol,
    strategyMode,
  };

  function saveX2XScannerState(next: X2XScannerState) {
    x2xScannerRef.current = next;
    setX2xScannerState(next);
    try {
      localStorage.setItem(X2X_SCANNER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // In-memory scanning still works if device storage is unavailable.
    }
  }

  function replaceX2XSignalHistory(next: X2XSignalRecord[]) {
    const bounded = next.slice(0, MAX_X2X_AUDIT_SIGNALS);
    x2xSignalsRef.current = bounded;
    setX2xSignals(bounded);
    persistX2XSignalHistory(bounded);
  }

  function upsertX2XSignal(record: X2XSignalRecord) {
    const existing = x2xSignalsRef.current.filter((signal) => signal.signalId !== record.signalId);
    replaceX2XSignalHistory([record, ...existing]);
  }

  function updateX2XSignal(signalId: string, patch: Partial<X2XSignalRecord>) {
    const next = x2xSignalsRef.current.map((signal) =>
      signal.signalId === signalId
        ? { ...signal, ...patch, updatedAt: new Date().toISOString() }
        : signal,
    );
    replaceX2XSignalHistory(next);
  }

  function recordX2XScannerEvent(event: X2XScannerEvent | null, state: X2XScannerState) {
    if (!event) {
      if (state.signal?.phase === "awaiting-op") {
        updateX2XSignal(state.signal.id, {
          status: "monitoring",
          ldp: state.signal.ldp,
          eligibleTicksElapsed: state.signal.eligibleTicksElapsed,
        });
      }
      return;
    }

    if (event.type === "pattern") {
      upsertX2XSignal({
        signalId: event.signalId,
        pattern: event.pattern,
        patternTickIds: event.patternTickIds,
        patternTickTimestamps: event.patternTickTimestamps,
        patternQuotes: event.patternQuotes,
        detectedAt: event.detectedAt,
        referencePair: event.referencePair,
        opTrigger: event.opTrigger,
        eligibleTicksLimit: event.eligibleTicksLimit,
        ldp: null,
        contractDuration: 1,
        eligibleTicksElapsed: 0,
        status: "signal_created",
        updatedAt: event.detectedAt,
      });
      return;
    }

    if (event.type === "invalid-reference") {
      upsertX2XSignal({
        signalId: event.signalId,
        pattern: event.pattern,
        patternTickIds: event.patternTickIds,
        patternTickTimestamps: event.patternTickTimestamps,
        patternQuotes: event.patternQuotes,
        detectedAt: event.detectedAt,
        referencePair: event.referencePair,
        opTrigger: null,
        ldp: null,
        contractDuration: 1,
        eligibleTicksElapsed: 0,
        status: "rejected",
        updatedAt: event.detectedAt,
        reason: `Reference ${event.referencePair} is below 20; subtracting 20 would be negative.`,
      });
      return;
    }

    const status: X2XSignalStatus =
      event.type === "ldp" ? "monitoring" : event.type === "trigger" ? "triggered" : "expired";
    updateX2XSignal(event.signalId, {
      status,
      ldp: event.ldp,
      eligibleTicksElapsed: event.type === "ldp" ? 0 : event.eligibleTicksElapsed,
      triggerAt: event.type === "trigger" ? event.timestamp : undefined,
      reason:
        event.type === "expired"
          ? `OP trigger did not appear within ${event.eligibleTicksLimit} eligible ticks.`
          : undefined,
    });
  }

  function cancelPendingX2XSignal(reason: string) {
    const { state, cancelledSignal: signal } = cancelX2XScanner(x2xScannerRef.current);
    if (!signal) return;
    if (!x2xSignalsRef.current.some((record) => record.signalId === signal.id)) {
      upsertX2XSignal({
        signalId: signal.id,
        pattern: signal.pattern,
        patternTickIds: signal.patternTickIds,
        patternTickTimestamps: signal.patternTickTimestamps,
        patternQuotes: signal.patternQuotes,
        detectedAt: signal.detectedAt,
        referencePair: signal.referencePair,
        opTrigger: signal.opTrigger,
        eligibleTicksLimit:
          signal.eligibleTicksLimit === undefined
            ? X2X_OP_WINDOW_TICKS
            : signal.eligibleTicksLimit,
        ldp: signal.ldp,
        contractDuration: 1,
        eligibleTicksElapsed: signal.eligibleTicksElapsed,
        status: signal.phase === "awaiting-ldp" ? "signal_created" : "monitoring",
        updatedAt: signal.detectedAt,
      });
    }
    updateX2XSignal(signal.id, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      reason,
      eligibleTicksElapsed: signal.eligibleTicksElapsed,
    });
    saveX2XScannerState(state);
  }

  function rememberX2XTick(identity: string): boolean {
    const seen = seenX2XTickIdsRef.current;
    if (!rememberUniqueX2XTick(seen, identity, MAX_X2X_SEEN_TICK_IDS)) return false;
    if (stateRef.current.strategyMode === "x2x" && stateRef.current.running) {
      try {
        localStorage.setItem(X2X_SEEN_TICK_IDS_STORAGE_KEY, JSON.stringify([...seen]));
      } catch {
        // Duplicate protection remains active for this page even without storage.
      }
    }
    return true;
  }

  useEffect(() => {
    const handlePageHide = () => {
      if (!stateRef.current.running) return;
      void publishSyncedAlert(
        "Bot stopped",
        `The app was closed on ${getDeviceLabel()} — bot is no longer running.`,
        "bot_stop",
      );
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  const applyBalanceToAccounts = useCallback(
    (loginid: string, balance: number, currency?: string) => {
      const idNorm = String(loginid).toUpperCase();
      setAccounts((prev) => {
        let matched = false;
        const updated = prev.map((acc) => {
          if (acc.account_id.toUpperCase() === idNorm) {
            matched = true;
            return {
              ...acc,
              balance: Number(balance).toFixed(2),
              currency: currency || acc.currency,
            };
          }
          return acc;
        });
        if (!matched) {
          const isDemo =
            idNorm.startsWith("VRTC") ||
            idNorm.startsWith("V") ||
            idNorm.startsWith("DOT") ||
            idNorm.startsWith("VRW");
          updated.push({
            account_id: loginid,
            account_type: isDemo ? "demo" : "real",
            currency: currency || "USD",
            balance: Number(balance).toFixed(2),
            status: "active",
          });
        }
        storeAccounts(updated);
        return updated;
      });
    },
    [],
  );

  // Refresh live balances from Deriv (never keep stale local demo balances)
  const refreshDerivBalances = useCallback(async () => {
    const manualToken = getManualToken();
    const authInfo = getStoredAuthInfo();
    const token = authInfo?.access_token || manualToken;
    if (!token) return;

    try {
      if (tradingRef.current?.isReady()) {
        await tradingRef.current.syncBalance(true);
        const saved = getStoredAccounts();
        if (saved.length > 0) setAccounts(saved);
        return;
      }
      const res = await authorizeWithToken(token);
      if (res.success && res.accounts.length > 0) {
        setAccounts(res.accounts);
        storeAccounts(res.accounts);
        const storedActive = getActiveAccountId();
        const chosen =
          res.accounts.find(
            (a) => a.account_id.toUpperCase() === String(storedActive || "").toUpperCase(),
          ) ||
          res.accounts.find((a) => a.account_type === "demo") ||
          res.accounts[0];
        if (chosen) {
          setActiveId(chosen.account_id);
          setActiveAccountId(chosen.account_id, chosen.account_type);
        }
        setIsConnectedToDeriv(true);
      }
    } catch {
      // Keep current balances on network error
    }
  }, []);

  // Check login session & accounts
  useEffect(() => {
    const hasIncomingOAuth =
      typeof window !== "undefined" &&
      (window.location.search.includes("code=") ||
        window.location.search.includes("token1=") ||
        window.location.hash.includes("code=") ||
        window.location.hash.includes("token1="));

    if (hasIncomingOAuth) {
      handleIncomingOAuth().then((res) => {
        if (res.handled && res.success) {
          session.set("deriv_trader");
          setEmail("deriv_trader");
          const saved = getStoredAccounts();
          if (saved.length > 0) {
            setAccounts(saved);
            const storedActive = getActiveAccountId();
            const chosen = saved.find((a) => a.account_id === storedActive) ?? saved[0];
            if (!chosen) return;
            setActiveId(chosen.account_id);
            setIsConnectedToDeriv(true);
          }
        }
      });
      return;
    }

    const userEmail = session.get();
    if (!userEmail) {
      navigate({ to: "/" });
      return;
    }
    setEmail(userEmail);

    const savedAccounts = getStoredAccounts();
    const storedActive = getActiveAccountId();
    const authInfo = getStoredAuthInfo();
    const manualToken = getManualToken();

    // Drop leftover fake accounts from older builds
    const realAccounts = savedAccounts.filter(
      (a) => a.account_id !== "VRTC1029384" && a.account_id !== "CR91945350",
    );
    if (realAccounts.length !== savedAccounts.length) {
      storeAccounts(realAccounts);
    }

    if (realAccounts.length > 0) {
      setAccounts(realAccounts);
      const chosen = realAccounts.find((a) => a.account_id === storedActive) ?? realAccounts[0];
      if (chosen) setActiveId(chosen.account_id);
      setIsConnectedToDeriv(Boolean(authInfo || manualToken));
    } else {
      setAccounts([]);
      setActiveId(null);
      setIsConnectedToDeriv(Boolean(manualToken || authInfo));
      if (!authInfo && !manualToken) {
        setShowConnectModal(true);
      }
    }

    refreshDerivBalances();
  }, [navigate, refreshDerivBalances]);

  // Connect to Deriv WebSocket tick feed & balance stream using configured App ID
  useEffect(() => {
    const marketInfo = getMarketConfig(marketSymbol);
    let feedPipDecimals = marketInfo.pipDecimals;
    const updateFeedPipDecimals = (value: unknown) => {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10) {
        feedPipDecimals = value;
        setMarketPipDecimals(value);
      }
    };
    setMarketPipDecimals(feedPipDecimals);
    const wsUrl = getDerivWsUrl(activeAppId);
    const ws = new DerivWS(wsUrl, (s) => setStatus(s));
    wsRef.current = ws;

    // Listen for live proposal responses from Deriv to sync exact App ID server markup
    ws.registerHandler("proposal", (data) => {
      const pData = data["proposal"] as { payout?: number; ask_price?: number };
      if (pData?.payout && pData?.ask_price) {
        const ask = pData.ask_price;
        const payout = pData.payout;
        const baseGross = ask * DERIV_MATCH_BASE_PAYOUT_RATIO;
        if (baseGross > 0) {
          const liveMarkup = Math.max(
            0,
            Math.round(((baseGross - payout) / baseGross) * 1000) / 10,
          );
          if (liveMarkup >= 0 && liveMarkup <= 10) {
            setConfiguredMarkup(liveMarkup);
            setAppIdMarkup(activeAppId, liveMarkup);
          }
        }
      }
    });

    // Listen for tick history and incoming live ticks
    ws.registerHandler("history", (data) => {
      const response = data as {
        history?: { prices?: number[]; times?: number[] };
        pip_size?: unknown;
      };
      const history = response.history;
      if (history?.prices && history.prices.length > 0) {
        updateFeedPipDecimals(response.pip_size);
        const pList = history.prices;
        const tList = history.times || [];
        const dList = pList.map((p) => lastDigit(p, feedPipDecimals));
        x2xTicksRef.current = pList.slice(-WINDOW).map((historicalPrice, index) => {
          const sourceIndex = pList.length - Math.min(WINDOW, pList.length) + index;
          const epoch = tList[sourceIndex];
          return {
            digit: lastDigit(historicalPrice, feedPipDecimals),
            lastTwoQuoteDigits: lastTwoQuoteDigits(historicalPrice, feedPipDecimals),
            quote: historicalPrice,
            timestamp: epoch ? new Date(epoch * 1000).toISOString() : undefined,
          };
        });
        digitsRef.current = dList;
        setDigits(dList);
        predictionRef.current = predictNextDigit(dList);
        setNextPrediction(predictionRef.current);
        setPredictionStats(emptyPredictionStats());
        setPrice(pList[pList.length - 1] ?? null);
        lastTickAt.current = Date.now();

        // Prepopulate tick stream strictly in chronological order (newest first for table)
        const initialTicks: TickItem[] = [];
        const count = Math.min(15, pList.length);
        for (let i = pList.length - count; i < pList.length; i++) {
          const ts = tList[i];
          const timestamp = ts
            ? new Date(ts * 1000).toLocaleTimeString()
            : new Date().toLocaleTimeString();
          initialTicks.unshift({
            time: timestamp,
            price: pList[i] ?? 0,
            digit: dList[i] ?? 0,
          });
        }
        setRecentTicks(initialTicks);

        setBotState((cur) => (cur === "BUFFERING" ? "IDLE" : cur));
        if (stateRef.current.strategyMode === "x2x") {
          setNote(
            `1,000 ticks loaded on ${marketInfo.displayName}. X2X scans the live chronological tick stream; the Matches spread target does not apply.`,
          );
        } else {
          const a = analyze(dList, stateRef.current.maxDiff);
          setNote(
            `1,000 ticks analyzed on ${marketInfo.displayName}: Entry [${a.most}] (${a.mostPct.toFixed(1)}%), Match Target [${a.second}] (${a.secondPct.toFixed(1)}%), Spread: ${a.diff.toFixed(2)}% (exact target: ${stateRef.current.maxDiff}%). ${a.ok ? "Target matched; ready to evaluate entries." : "Target not matched; scanning until the spread equals the selected value."}`,
          );
        }
      }
    });

    ws.registerHandler("tick", (data) => {
      const tick = data["tick"] as {
        quote?: number;
        epoch?: number;
        id?: string | number;
        pip_size?: unknown;
      };
      if (typeof tick?.quote === "number") {
        updateFeedPipDecimals(tick.pip_size);
        const q = tick.quote;
        // Deriv does not guarantee tick.id is unique; dedupe by quote time and value.
        const tickIdentity =
          tick.epoch !== undefined
            ? `${marketSymbol}:${tick.epoch}:${q.toFixed(feedPipDecimals)}`
            : null;
        if (tickIdentity && !rememberX2XTick(tickIdentity)) return;
        const timeStr = tick.epoch
          ? new Date(tick.epoch * 1000).toLocaleTimeString()
          : new Date().toLocaleTimeString();
        const tickInfo: X2XQuoteDigit = {
          digit: lastDigit(q, feedPipDecimals),
          lastTwoQuoteDigits: lastTwoQuoteDigits(q, feedPipDecimals),
          quote: q,
          tickId:
            tickIdentity ??
            (tick.id === undefined ? undefined : `${marketSymbol}:${tick.id}:${Date.now()}`),
          timestamp: tick.epoch
            ? new Date(tick.epoch * 1000).toISOString()
            : new Date().toISOString(),
        };
        const nextDigit = lastDigit(q, feedPipDecimals);
        const priorPrediction = predictionRef.current;
        const predictionCorrect = priorPrediction ? priorPrediction.digit === nextDigit : undefined;
        lastTickAt.current = Date.now();

        setPrice(q);

        // Score the forecast made before this tick arrived, then show the actual result.
        setRecentTicks((prev) => [
          {
            time: timeStr,
            price: q,
            digit: nextDigit,
            predictedDigit: priorPrediction?.digit,
            predictionCorrect,
          },
          ...prev.slice(0, 14),
        ]);
        if (predictionCorrect !== undefined) {
          setPredictionStats((previous) => ({
            forecasts: previous.forecasts + 1,
            correct: previous.correct + (predictionCorrect ? 1 : 0),
            recentResults: [...previous.recentResults, predictionCorrect].slice(-100),
            currentStreak:
              previous.lastResult === predictionCorrect ? previous.currentStreak + 1 : 1,
            lastResult: predictionCorrect,
          }));
        }

        // Digits stream: append synchronously into ref to avoid state-updater batching issues
        digitsRef.current.push(nextDigit);
        if (digitsRef.current.length > WINDOW) {
          digitsRef.current.shift();
        }
        const updatedDigits = [...digitsRef.current];
        setDigits(updatedDigits);
        predictionRef.current = predictNextDigit(updatedDigits);
        setNextPrediction(predictionRef.current);
        x2xTicksRef.current = [...x2xTicksRef.current, tickInfo].slice(-WINDOW);

        // Process trade event immediately with guaranteed current digits
        handleTickEventRef.current(updatedDigits, q, nextDigit, tickInfo);
      }
    });

    // Request 1000 ticks: uses selected market symbol (classic/options feed)
    const subscribeTicks = async () => {
      const payload = (sym: string) => ({
        ticks_history: sym,
        count: WINDOW,
        end: "latest",
        style: "ticks",
        subscribe: 1,
      });
      try {
        await ws.send(payload(marketInfo.classicSymbol));
      } catch {
        try {
          await ws.send(payload(marketInfo.optionsSymbol));
        } catch (err) {
          console.error("Ticks subscription error:", err);
          // Last resort: classic Binary public socket
          try {
            ws.updateUrl(`wss://ws.derivws.com/websockets/v3?app_id=1089`);
            await ws.waitForOpen(8000);
            await ws.send(payload(marketInfo.classicSymbol));
          } catch (fallbackErr) {
            console.error("Classic ticks fallback failed:", fallbackErr);
          }
        }
      }
    };
    subscribeTicks();

    return () => {
      ws.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAppId, marketSymbol]);

  // Authorized trading socket (balance + live DIGITMATCH buys) for the active account
  useEffect(() => {
    const token = getStoredAuthInfo()?.access_token || getManualToken();
    if (!token || !activeAccount?.account_id) {
      setTradingReady(false);
      tradingRef.current?.dispose();
      tradingRef.current = null;
      return;
    }

    const session = new DerivTradingSession();
    tradingRef.current = session;

    const unsubBal = session.onBalance((loginid, balance, currency) => {
      applyBalanceToAccounts(loginid, balance, currency);
      const idNorm = String(loginid).toUpperCase();
      // Keep the UI on the account Deriv actually authorized
      setActiveId((cur) => {
        if (cur && cur.toUpperCase() === idNorm) return cur;
        if (!cur) {
          setActiveAccountId(loginid);
          return loginid;
        }
        return cur;
      });
    });

    const unsubStatus = session.onStatus((st, detail) => {
      if (st === "ready") {
        if (stateRef.current.running && connectionLostAlertedRef.current) {
          notifyConnectionRestored();
        }
        connectionLostAlertedRef.current = false;
        setTradingReady(true);
        const modeLabel = detail === "otp" ? "Auth 2.0" : "authorized";
        setTradingStatusNote(`Live trading ready (${modeLabel})`);
        setIsConnectedToDeriv(true);
        const authorizedId = session.getAccountId();
        if (authorizedId) {
          setActiveId(authorizedId);
          setActiveAccountId(authorizedId);
        }
      } else if (st === "connecting") {
        setTradingReady(false);
        setTradingStatusNote("Opening authorized Deriv trading socket...");
      } else if (st === "error" || st === "offline") {
        setTradingReady(false);
        setTradingStatusNote(detail || "Trading socket offline");
        if (stateRef.current.running && !connectionLostAlertedRef.current) {
          connectionLostAlertedRef.current = true;
          notifyConnectionLost(
            detail || "The bot is paused while the Deriv connection reconnects.",
          );
        }
      }
    });

    session.connect(activeAccount).catch(() => {
      setTradingReady(false);
    });

    return () => {
      unsubBal();
      unsubStatus();
      session.dispose();
      if (tradingRef.current === session) tradingRef.current = null;
      setTradingReady(false);
    };
  }, [activeAccount?.account_id, applyBalanceToAccounts]);

  function settleTradeResult(
    p: PendingTrade,
    won: boolean,
    pnl: number,
    resultDigit: number,
    updateLocalBalance: boolean,
    balanceAfter?: number,
    contractId?: number,
  ) {
    const s = stateRef.current;

    if (won || !s.martingaleEnabled) {
      lossStreakRef.current = 0;
    } else {
      lossStreakRef.current += 1;
    }

    if (won) {
      notifyTradeWon(p.runIndex, Math.abs(pnl), p.target);
    } else {
      notifyTradeLost(p.runIndex, p.stake, resultDigit, p.target);
    }

    const newRow: TradeRow = {
      id: Date.now(),
      runIndex: p.runIndex,
      entry: p.entry,
      target: p.target,
      result: resultDigit,
      stake: p.stake,
      pnl,
      time: new Date().toLocaleTimeString(),
      signalId: p.signalId,
      contractId,
    };

    const updatedTrades = [newRow, ...s.trades];
    setTrades(updatedTrades);
    if (p.signalId) {
      updateX2XSignal(p.signalId, {
        status: "settled",
        contractId,
        stake: p.stake,
        result: won ? "won" : "lost",
        reason: undefined,
      });
    }

    if (updateLocalBalance) {
      // Paper mode only — live balances come from Deriv buy/balance sockets
      setAccounts((prev) => {
        const targetId = (
          s.activeId ||
          activeId ||
          (prev[0] ? prev[0].account_id : "")
        ).toUpperCase();
        const updated = prev.map((acc) => {
          if (acc.account_id.toUpperCase() === targetId || (!targetId && acc === prev[0])) {
            const currentBal = parseFloat(acc.balance) || 0;
            const nextBal = Math.max(0, Math.round((currentBal + pnl) * 100) / 100);
            return { ...acc, balance: nextBal.toFixed(2) };
          }
          return acc;
        });
        storeAccounts(updated);
        return updated;
      });
    } else {
      const loginid = tradingRef.current?.getAccountId() || s.activeId || activeId;
      if (loginid && typeof balanceAfter === "number" && Number.isFinite(balanceAfter)) {
        applyBalanceToAccounts(loginid, balanceAfter);
      }
      // Re-read from Deriv so the UI matches the real account after every trade
      void (async () => {
        try {
          await tradingRef.current?.syncBalance(true);
        } catch {
          await refreshDerivBalances();
        }
        const saved = getStoredAccounts();
        if (saved.length > 0) setAccounts(saved);
      })();
    }

    const totalPnl = updatedTrades.reduce((acc, t) => acc + t.pnl, 0);
    const nextRunCount = s.runCount + 1;
    setRunCount(nextRunCount);

    if (s.tp > 0 && totalPnl >= s.tp) {
      notifyTakeProfit(totalPnl);
      return stopBot(`Take Profit reached (+$${totalPnl.toFixed(2)}). Bot stopped.`);
    }
    if (s.sl > 0 && totalPnl <= -s.sl) {
      notifyStopLoss(totalPnl);
      return stopBot(`Stop Loss reached (-$${Math.abs(totalPnl).toFixed(2)}). Bot stopped.`);
    }

    if (won && s.stopOnWin) {
      return stopBot(
        `First win landed (+$${totalPnl.toFixed(2)}) — bot stopped after 1 win.`,
      );
    }

    if (!won && s.reAnalyzeOnLoss) {
      lossCooldownTicks.current = 5;
      setBotState("LOSS RE-ANALYSIS");
      setNote(
        `Trade #${p.runIndex} lost (${resultDigit} ≠ ${p.target}). Re-analyzing market distribution...`,
      );
      return;
    }

    setBotState("ANALYZING");
    setNote(
      `Trade #${p.runIndex} ${won ? "won" : "lost"} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD). Analyzing for trade #${nextRunCount + 1}...`,
    );
  }

  function placeLiveMatch(p: PendingTrade) {
    const session = tradingRef.current;
    const currency = activeAccount?.currency || "USD";
    if (!session?.isReady()) {
      pending.current = null;
      setBotState("ANALYZING");
      setNote("Trading session connecting. Will retry on next signal...");
      if (p.signalId) {
        updateX2XSignal(p.signalId, {
          status: "failed",
          reason: "The authorized trading session was unavailable before purchase.",
        });
      }
      return;
    }

    session
      .buyDigitMatch({
        stake: p.stake,
        barrierDigit: p.target,
        currency,
        symbol: stateRef.current.marketSymbol || currentMarket.id,
      })
      .then((result: ContractResult) => {
        if (pending.current?.live && pending.current.runIndex === p.runIndex) {
          pending.current = null;
        }
        const pnl = Number(result.profit);
        const resultDigit =
          typeof result.exitDigit === "number" ? result.exitDigit : result.won ? p.target : -1;
        settleTradeResult(
          p,
          result.won || pnl > 0,
          pnl,
          resultDigit,
          false,
          result.balanceAfter,
          result.contractId,
        );
      })
      .catch((err: Error) => {
        pending.current = null;
        pendingSetAt.current = 0;
        const limitHit = isDerivLimitError(err);
        if (p.signalId) {
          updateX2XSignal(p.signalId, {
            status: "failed",
            reason: `Contract purchase or settlement failed: ${err.message}`,
          });
        }
        lossCooldownTicks.current = limitHit ? 20 : 5;
        setBotState("LOSS RE-ANALYSIS");
        setNote(
          limitHit
            ? `Trading connection is cooling down after a temporary request cap. Waiting ${lossCooldownTicks.current} ticks for a fresh entry signal...`
            : `Trade notice: ${err.message}. Waiting ${lossCooldownTicks.current} ticks before retry...`,
        );
        const userFacingError = limitHit
          ? "Temporary request cap. Cleared stale subscriptions and paused briefly before retrying."
          : err.message;
        setTradingStatusNote(userFacingError);
        if (stateRef.current.running) notifyTradeFailed(userFacingError);
      });
  }

  function handleTickEvent(
    tickList: number[],
    _currentPrice: number,
    currentD: number,
    tickInfo: X2XQuoteDigit,
  ) {
    const s = stateRef.current;
    let x2xEvent: X2XScannerEvent | null = null;

    // Scan every incoming live tick in order, even while a contract settles.
    // The OP window only consumes ticks when the engine can accept a new trade.
    if (s.running && s.strategyMode === "x2x") {
      const tradeBusy = Boolean(pending.current?.live || tradingRef.current?.isBuyInFlight());
      const opEligible =
        !tradeBusy && lossCooldownTicks.current === 0 && Boolean(tradingRef.current?.isReady());
      const step = advanceX2XScanner(
        x2xScannerRef.current,
        tickInfo,
        opEligible,
        s.x2xOpWaitTicks,
      );
      saveX2XScannerState(step.state);
      x2xEvent = step.event;
      recordX2XScannerEvent(step.event, step.state);
    }

    // Live contracts settle via Deriv proposal_open_contract — ignore local tick settlement
    if (pending.current?.live || tradingRef.current?.isBuyInFlight()) {
      // Safety net: if pending has been stuck for >60 seconds AND no buy is in flight
      const elapsed = Date.now() - pendingSetAt.current;
      if (elapsed > 60_000 && !tradingRef.current?.isBuyInFlight()) {
        console.warn(
          "[bot] Force-clearing stuck pending trade after",
          Math.round(elapsed / 1000),
          "seconds",
        );
        pending.current = null;
        pendingSetAt.current = 0;
        lossCooldownTicks.current = 5;
        setBotState("LOSS RE-ANALYSIS");
        setNote("Trade settlement timed out. Cooling down before the next entry...");
        return;
      }
      return;
    }

    // Clear any stale non-live pending trade and continue scanning
    if (pending.current && !pending.current.live) {
      pending.current = null;
    }

    if (!s.running) return;

    if (s.strategyMode === "x2x") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setBotState("LOSS RE-ANALYSIS");
        setNote(`X2X loss protection: ${lossCooldownTicks.current} eligible ticks remaining...`);
        return;
      }

      if (x2xEvent?.type === "trigger") {
        const session = tradingRef.current;
        if (!session?.isReady()) {
          updateX2XSignal(x2xEvent.signalId, {
            status: "failed",
            reason: "OP matched while the authorized trading connection was unavailable.",
          });
          setBotState("ANALYZING");
          setNote(
            "X2X OP matched, but the Deriv trading session is reconnecting. The signal was recorded as failed and will not be retried.",
          );
          return;
        }
        if (session.isBuyInFlight()) {
          updateX2XSignal(x2xEvent.signalId, {
            status: "failed",
            reason: "A Deriv purchase was already in flight when the OP trigger appeared.",
          });
          setBotState("IN TRADE");
          setNote("Waiting for the current Deriv contract to settle...");
          return;
        }

        const targetRun = s.runCount + 1;
        const nextStake = calculateMartingaleStake(
          s.stake,
          lossStreakRef.current,
          s.martingaleEnabled,
        );
        const availableBalance = activeAccount
          ? Number(activeAccount.balance)
          : Number.POSITIVE_INFINITY;
        if (nextStake > availableBalance) {
          updateX2XSignal(x2xEvent.signalId, {
            status: "failed",
            reason: `Stake ${nextStake.toFixed(2)} exceeded the available balance.`,
          });
          stopBot(
            `Bot paused: the next stake ($${nextStake.toFixed(2)}) exceeds the available balance ($${availableBalance.toFixed(2)}). Lower the base stake or turn off 1.5× martingale.`,
          );
          return;
        }

        pending.current = {
          runIndex: targetRun,
          entry: currentD,
          target: x2xEvent.ldp,
          stake: nextStake,
          live: true,
          signalId: x2xEvent.signalId,
        };
        updateX2XSignal(x2xEvent.signalId, {
          status: "trade_submitted",
          stake: nextStake,
          triggerAt: x2xEvent.timestamp,
        });
        pendingSetAt.current = Date.now();
        setBotState("IN TRADE");
        setNote(
          `X2X OP ${x2xEvent.opTrigger} matched. Buying 1-tick DIGITMATCH on ${currentMarket.displayName} with stored LDP ${x2xEvent.ldp}...`,
        );
        placeLiveMatch(pending.current);
        return;
      }

      if (x2xEvent?.type === "pattern") {
        setBotState("ANALYZING");
        setNote(
          `X2X ${x2xEvent.pattern} detected across consecutive ticks. Reference ${x2xEvent.referencePair} gives OP ${x2xEvent.opTrigger}; waiting for the next tick's LDP...`,
        );
      } else if (x2xEvent?.type === "ldp") {
        setBotState("WAITING ENTRY");
        setNote(
          x2xScannerRef.current.signal?.eligibleTicksLimit === null
            ? `X2X LDP ${x2xEvent.ldp} stored. Waiting for quote suffix ${x2xEvent.opTrigger} with no expiry...`
            : `X2X LDP ${x2xEvent.ldp} stored. Waiting for quote suffix ${x2xEvent.opTrigger} within ${x2xScannerRef.current.signal?.eligibleTicksLimit ?? X2X_OP_WINDOW_TICKS} eligible ticks...`,
        );
      } else if (x2xEvent?.type === "expired") {
        setBotState("ANALYZING");
        setNote(
          `X2X signal expired: OP ${x2xEvent.opTrigger} did not appear within ${x2xEvent.eligibleTicksLimit} eligible ticks.`,
        );
      } else if (x2xEvent?.type === "invalid-reference") {
        setBotState("ANALYZING");
        setNote(
          `X2X ${x2xEvent.pattern} skipped: reference ${x2xEvent.referencePair} is below 20 and cannot produce a two-digit OP trigger.`,
        );
      } else if (x2xScannerRef.current.signal?.phase === "awaiting-op") {
        setBotState("WAITING ENTRY");
      } else {
        setBotState("ANALYZING");
      }
      return;
    }

    if (lossCooldownTicks.current > 0) {
      lossCooldownTicks.current -= 1;
      setBotState("LOSS RE-ANALYSIS");
      setNote(`Cooling down before next entry (${lossCooldownTicks.current} ticks remaining)...`);
      return;
    }

    if (tickList.length < WINDOW) {
      setBotState("BUFFERING");
      setNote(
        `Buffering market ticks (${tickList.length}/${WINDOW}). Analyzing last 1,000 ticks before evaluating entry...`,
      );
      return;
    }

    if (s.botState === "LOSS RE-ANALYSIS") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setNote(
          `Loss re-analysis: streaming fresh ticks (${lossCooldownTicks.current} remaining)...`,
        );
        return;
      }
      setBotState("ANALYZING");
    }

    const a = analyze(tickList, s.maxDiff);

    if (shouldEnter(a, currentD)) {
      const targetRun = s.runCount + 1;
      const session = tradingRef.current;
      const useLive = Boolean(session?.isReady());
      if (!useLive) {
        setBotState("ANALYZING");
        setNote("Waiting for Deriv trading connection before entering trade...");
        return;
      }
      if (session?.isBuyInFlight()) {
        setBotState("IN TRADE");
        setNote("Waiting for the current Deriv contract to settle...");
        return;
      }
      const nextStake = calculateMartingaleStake(
        s.stake,
        lossStreakRef.current,
        s.martingaleEnabled,
      );
      const availableBalance = activeAccount
        ? Number(activeAccount.balance)
        : Number.POSITIVE_INFINITY;
      if (nextStake > availableBalance) {
        stopBot(
          `Bot paused: the next stake ($${nextStake.toFixed(2)}) exceeds the available balance ($${availableBalance.toFixed(2)}). Lower the base stake or turn off 1.5× martingale.`,
        );
        return;
      }
      pending.current = {
        runIndex: targetRun,
        entry: currentD,
        target: a.second,
        stake: nextStake,
        live: true,
      };
      pendingSetAt.current = Date.now();
      setBotState("IN TRADE");
      setNote(
        `Trade #${targetRun}: Buying DIGITMATCH on ${currentMarket.displayName} — entry ${currentD}, match ${a.second}...`,
      );
      placeLiveMatch(pending.current);
    } else if (a.ok) {
      setBotState("WAITING ENTRY");
      setNote(
        `Spread matched exact target (Δ ${a.diff.toFixed(2)}% = ${s.maxDiff}%). Waiting for entry digit ${a.most}...`,
      );
    } else {
      setBotState("ANALYZING");
      setNote(
        `Spread Δ ${a.diff.toFixed(2)}% does not equal target ${s.maxDiff}%. Analyzing last 1,000 ticks...`,
      );
    }
  }

  function startBot() {
    initAudioContext();
    const currentSessionPnl = trades.reduce((total, trade) => total + trade.pnl, 0);
    if (tp > 0 && currentSessionPnl >= tp) {
      setNote(
        "Take Profit is already reached for this session. Save or reset the session before restarting.",
      );
      return;
    }
    if (sl > 0 && currentSessionPnl <= -sl) {
      setNote(
        "Stop Loss is already reached for this session. Save or reset the session before restarting.",
      );
      return;
    }
    if (digits.length < startTickRequirement) {
      setNote(
        strategyMode === "x2x"
          ? `Cannot start X2X Sniper: waiting for at least ${startTickRequirement} live market ticks.`
          : `Cannot start bot: Buffering market ticks (${digits.length}/${WINDOW}) on ${currentMarket.displayName}. Exactly 1,000 ticks must be analyzed before entering a trade.`,
      );
      return;
    }
    if (!isConnectedToDeriv) {
      setShowConnectModal(true);
      setNote("Connect Deriv Auth 2.0 so trades hit your account and the balance updates.");
      return;
    }
    if (!activeAccount) {
      setShowConnectModal(true);
      setNote("No Deriv account selected. Connect Deriv first.");
      return;
    }
    pending.current = null;
    cancelPendingX2XSignal("Bot restarted; the previous X2X signal was cancelled.");
    saveX2XScannerState(createX2XScannerState());
    lossCooldownTicks.current = 0;
    lossStreakRef.current = 0;
    connectionLostAlertedRef.current = false;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("deriv_bot_is_running", "true");
      } catch {
        setTradingStatusNote(
          "Browser storage is unavailable. The bot will run in this tab but cannot auto-resume after refresh.",
        );
      }
    }
    const tradingConnectionReady = tradingReady && Boolean(tradingRef.current?.isReady());
    setRunning(true);
    stateRef.current.running = true;
    setBotState("ANALYZING");
    setNote(
      tradingConnectionReady
        ? strategyMode === "x2x"
          ? `X2X Sniper active on ${activeAccount.account_id}. Scanning ${currentMarket.displayName} tick digits for X2X signals...`
          : `Bot active on ${activeAccount.account_id}. Live DIGITMATCH buys on ${currentMarket.displayName} — trade #${runCount + 1}...`
        : `Bot started on ${activeAccount.account_id}. Market scanning is active and will place no trade until the authorized Deriv trading connection is ready.`,
    );
    notifyBotStarted(activeAccount.account_id, getDeviceLabel());
  }

  function stopBot(message: string) {
    const wasRunning = running || stateRef.current.running;
    cancelPendingX2XSignal("Bot stopped by user; the pending X2X signal was cancelled.");
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem("deriv_bot_is_running");
      } catch {
        // Stopping the bot must still work when browser storage is unavailable.
      }
    }
    setRunning(false);
    stateRef.current.running = false;
    connectionLostAlertedRef.current = false;
    setBotState("IDLE");
    setNote(message);
    pending.current = null;
    saveX2XScannerState(createX2XScannerState());
    if (wasRunning) {
      notifyBotStopped(message);
    }
  }

  function saveCurrentSession() {
    if (running) {
      setNote("Stop the bot before saving and clearing this session.");
      return;
    }

    cancelPendingX2XSignal("Session saved; the pending X2X signal was cancelled.");
    const signalHistory = x2xSignalsRef.current;
    if (trades.length === 0 && signalHistory.length === 0) return;

    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const losses = trades.filter((trade) => trade.pnl < 0).length;
    const snapshot: SavedSession = {
      id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      savedAt: new Date().toISOString(),
      marketSymbol,
      trades: trades.map((trade) => ({ ...trade })),
      totalPnl: trades.reduce((total, trade) => total + trade.pnl, 0),
      wins,
      losses,
      winRate: trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0,
      spreadThreshold: maxDiff,
      baseStake: stake,
      martingaleEnabled,
      strategyMode,
      x2xSignals: signalHistory.map((signal) => ({ ...signal })),
      ...(strategyMode === "x2x" ? { x2xOpWaitTicks } : {}),
    };
    const nextHistory = [snapshot, ...savedSessions].slice(0, MAX_SAVED_SESSIONS);
    if (!persistSavedSessions(nextHistory)) {
      setNote("Could not save session history. Browser storage may be unavailable or full.");
      return;
    }

    setSavedSessions(nextHistory);
    setTrades([]);
    replaceX2XSignalHistory([]);
    saveX2XScannerState(createX2XScannerState());
    setRunCount(0);
    lossStreakRef.current = 0;
    setExpandedHistoryId(snapshot.id);
    setCenterTab("session_history");
    setNote("Session saved to this device's history.");
  }

  function resetSession() {
    stopBot("Session reset.");
    setTrades([]);
    setRunCount(0);
    lossStreakRef.current = 0;
  }

  // Pull the latest balance from Deriv (demo top-ups happen in Deriv, not locally)
  function resetDemoBalance() {
    refreshDerivBalances();
    setNote("Synced balance from Deriv. Top up demo funds in your Deriv account if needed.");
  }

  // Desktop PWA & Background Tab Keepalive Engine
  useEffect(() => {
    if (running) {
      keepaliveCleanupRef.current = startBotKeepalive(() => {
        // Background Web Worker heartbeat (fires unthrottled every 1s)
        const now = Date.now();
        // 1. Recover stalled tick feed (>8s)
        if (now - lastTickAt.current > 8000) {
          if (wsRef.current) {
            wsRef.current.send({ ping: 1 }).catch(() => {
              wsRef.current?.reconnect();
            });
          }
        }
        // 2. Recover trading session readiness
        if (tradingRef.current && !tradingRef.current.isReady() && activeAccount) {
          tradingRef.current.connect(activeAccount).catch(() => {});
        }
      });
    } else {
      if (keepaliveCleanupRef.current) {
        keepaliveCleanupRef.current();
        keepaliveCleanupRef.current = null;
      }
      stopBotKeepalive();
    }

    return () => {
      if (keepaliveCleanupRef.current) {
        keepaliveCleanupRef.current();
        keepaliveCleanupRef.current = null;
      }
      stopBotKeepalive();
    };
  }, [running, activeAccount]);

  // Screen Wake Lock & Socket Re-activation on visibility restore or focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (stateRef.current.running) {
          void requestScreenWakeLock();
        }
        if (wsRef.current) {
          wsRef.current.send({ ping: 1 }).catch(() => {
            wsRef.current?.reconnect();
          });
        }
        if (tradingRef.current && !tradingRef.current.isReady() && activeAccount) {
          tradingRef.current.connect(activeAccount).catch(() => {});
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [activeAccount]);

  // Auto-resume running state from localStorage if restored
  useEffect(() => {
    let wasRunning = false;
    if (typeof window !== "undefined") {
      try {
        wasRunning = localStorage.getItem("deriv_bot_is_running") === "true";
      } catch {
        // Auto-resume is optional; the bot can still be started manually.
      }
    }
    if (
      wasRunning &&
      !running &&
      digits.length >= startTickRequirement &&
      tradingReady &&
      isConnectedToDeriv
    ) {
      console.log("[bot] Auto-resuming bot from persistent running state...");
      setRunning(true);
      stateRef.current.running = true;
      setBotState("ANALYZING");
      setNote(
        strategyMode === "x2x"
          ? `X2X Sniper resumed on ${activeAccount?.account_id || "Deriv"}. Scanning ${currentMarket.displayName} tick digits...`
          : `Bot resumed on ${activeAccount?.account_id || "Deriv"}. Live DIGITMATCH on ${currentMarket.displayName}...`,
      );
    }
  }, [
    digits.length,
    tradingReady,
    isConnectedToDeriv,
    running,
    activeAccount?.account_id,
    currentMarket.displayName,
    startTickRequirement,
    strategyMode,
  ]);

  function runBacktest1000Ticks() {
    if (strategyMode === "x2x") {
      if (x2xTicksRef.current.length < WINDOW) {
        setNote(
          `X2X replay needs 1,000 ${currentMarket.displayName} quotes (${x2xTicksRef.current.length}/1,000 loaded).`,
        );
        return;
      }
      const replay = runX2XBacktest(x2xTicksRef.current.slice(-WINDOW), {
        reAnalyzeOnLoss,
        cooldownTicks: 5,
        opWaitTicks: x2xOpWaitTicks,
      });
      setBacktest({
        strategyMode: "x2x",
        totalTicks: replay.totalTicks,
        signals: replay.validSignals,
        wins: replay.wins,
        losses: replay.losses,
        winRate: replay.winRate,
        netPnl: null,
        x2x: replay,
      });
      setShowBacktestModal(true);
      return;
    }
    if (digits.length < WINDOW) {
      alert(
        `Buffering market ticks. Exactly 1,000 ticks are required to calculate the test (${digits.length}/${WINDOW} collected so far).`,
      );
      return;
    }

    const windowDigits = digits.slice(-WINDOW);
    const a = analyze(windowDigits, maxDiff);
    let signals = 0;
    let wins = 0;
    let losses = 0;
    let pnl = 0;

    if (a.ok) {
      for (let i = 0; i < windowDigits.length - 1; i++) {
        if (windowDigits[i] === a.most) {
          signals++;
          const nextDigit = windowDigits[i + 1];
          if (nextDigit === a.second) {
            wins++;
            pnl += calculateMatchesPayout(stake, configuredMarkup).netWinProfit;
          } else {
            losses++;
            pnl -= stake;
          }
        }
      }
    }

    const winRate = signals > 0 ? (wins / signals) * 100 : 0;
    setBacktest({
      strategyMode: "matches",
      totalTicks: windowDigits.length,
      signals,
      wins,
      losses,
      winRate,
      netPnl: pnl,
    });
    setShowBacktestModal(true);
  }

  function switchAccount(id: string) {
    const acc = accounts.find((a) => a.account_id === id);
    if (acc) {
      setActiveId(acc.account_id);
      setActiveAccountId(acc.account_id, acc.account_type);
    }
  }

  function toggleDemoReal() {
    const targetType = activeType === "real" ? "demo" : "real";
    const targetAcc = accounts.find((a) => a.account_type === targetType);
    if (targetAcc) {
      switchAccount(targetAcc.account_id);
    } else {
      setNote(
        `No ${targetType} account on this Deriv login. Open Deriv and create one, then reconnect.`,
      );
      setShowConnectModal(true);
    }
  }

  function triggerManualTestTrade() {
    initAudioContext();
    if (strategyMode === "x2x") {
      setNote(
        "TEST 1 is only available for Matches. X2X trades require a live pattern and OP signal.",
      );
      return;
    }
    if (digits.length < WINDOW) {
      alert(`Buffering market ticks (${digits.length}/${WINDOW}). Exactly 1,000 ticks required.`);
      return;
    }
    if (!tradingReady || !isConnectedToDeriv) {
      setShowConnectModal(true);
      setNote("Connect Deriv before placing a live test trade.");
      return;
    }
    const a = analyze(digits, maxDiff);
    const targetRun = runCount + 1;
    const testStake = calculateMartingaleStake(stake, lossStreakRef.current, martingaleEnabled);
    const availableBalance = activeAccount
      ? Number(activeAccount.balance)
      : Number.POSITIVE_INFINITY;
    if (testStake > availableBalance) {
      setNote(
        `Test trade not placed: the next stake ($${testStake.toFixed(2)}) exceeds the available balance ($${availableBalance.toFixed(2)}).`,
      );
      return;
    }
    const p: PendingTrade = {
      runIndex: targetRun,
      entry: a.most,
      target: a.second,
      stake: testStake,
      live: true,
    };
    pending.current = p;
    pendingSetAt.current = Date.now();
    setBotState("IN TRADE");
    setNote(
      `Test trade #${targetRun}: Buying DIGITMATCH — match digit ${a.second} on Deriv...`,
    );
    placeLiveMatch(p);
  }

  async function handleDirectOAuth() {
    try {
      await startDerivAuth({
        clientId: getDerivClientId(),
        redirectUri: derivRedirectUri(),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not start Deriv Auth 2.0");
    }
  }

  const analysis = analyze(digits, maxDiff);
  const currentDigit = digits[digits.length - 1];
  const totalPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;
  const x2xTriggeredCount = x2xSignals.filter((signal) => Boolean(signal.triggerAt)).length;
  const x2xSubmittedCount = x2xSignals.filter((signal) =>
    ["trade_submitted", "settled"].includes(signal.status),
  ).length;
  const x2xExecutedCount = x2xSignals.filter((signal) => signal.contractId !== undefined).length;
  const x2xWins = x2xSignals.filter((signal) => signal.result === "won").length;
  const x2xLosses = x2xSignals.filter((signal) => signal.result === "lost").length;
  const x2xSettledCount = x2xWins + x2xLosses;
  const x2xWinRate = x2xSettledCount ? Math.round((x2xWins / x2xSettledCount) * 100) : 0;
  const x2xExpiredCount = x2xSignals.filter((signal) => signal.status === "expired").length;
  const x2xRejectedCount = x2xSignals.filter((signal) =>
    ["rejected", "cancelled", "failed"].includes(signal.status),
  ).length;
  const predictionAccuracy =
    predictionStats.forecasts > 0
      ? Math.round((predictionStats.correct / predictionStats.forecasts) * 100)
      : null;
  const recentPredictionAccuracy =
    predictionStats.recentResults.length > 0
      ? Math.round(
          (predictionStats.recentResults.filter(Boolean).length /
            predictionStats.recentResults.length) *
            100,
        )
      : null;
  const scoredTicks = recentTicks.filter((tick) => tick.predictedDigit !== undefined).slice(0, 10);

  // Strictly chronological sequence of the latest 33 digits (incoming order from left to right)
  const recentDigits33 = digits.slice(-33);

  return (
    <div
      className={`min-h-screen font-sans antialiased transition-colors overflow-x-hidden ${
        isDark ? "bg-black text-white" : "bg-[#f4f6f8] text-slate-800"
      }`}
    >
      {/* Floating In-App Alert Toast (Docked above mobile bottom bar, bottom-right on desktop) */}
      {inAppAlert && (
        <aside
          role="status"
          aria-live="polite"
          style={{ bottom: "calc(max(env(safe-area-inset-bottom, 0px), 0.75rem) + 4.75rem)" }}
          className="fixed left-1/2 -translate-x-1/2 z-50 w-[calc(100%-1.5rem)] max-w-md animate-in fade-in slide-in-from-bottom-3 duration-200 lg:top-auto lg:bottom-6 lg:left-auto lg:right-6 lg:translate-x-0 lg:w-80 lg:slide-in-from-right-4"
        >
          <div
            className={`rounded-xl border px-4 py-3 shadow-2xl flex items-center justify-between gap-3 backdrop-blur-md ${
              inAppAlert.type === "win"
                ? isDark
                  ? "border-emerald-500/60 bg-zinc-950/95 text-emerald-400"
                  : "border-emerald-500 bg-emerald-50/95 text-emerald-800 shadow-emerald-950/10"
                : inAppAlert.type === "loss"
                  ? isDark
                    ? "border-red-500/60 bg-zinc-950/95 text-red-400"
                    : "border-red-500 bg-red-50/95 text-red-800 shadow-red-950/10"
                  : isDark
                    ? "border-zinc-800 bg-zinc-950/95 text-white"
                    : "border-slate-300 bg-white/95 text-slate-900 shadow-slate-950/10"
            }`}
          >
            <div className="space-y-0.5 min-w-0 flex-1">
              <div className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    inAppAlert.type === "win"
                      ? "bg-emerald-400"
                      : inAppAlert.type === "loss"
                        ? "bg-rose-500"
                        : "bg-sky-400"
                  }`}
                />
                <span className="truncate">{inAppAlert.title}</span>
              </div>
              <div className="text-[11px] opacity-90 leading-snug break-words">
                {inAppAlert.body}
              </div>
            </div>
            <button
              onClick={() => setInAppAlert(null)}
              aria-label="Dismiss alert"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2 -my-2 text-xs font-bold opacity-60 hover:opacity-100 transition-opacity"
            >
              [X]
            </button>
          </div>
        </aside>
      )}

      {/* 1. Header Bar: Responsive for Mobile, Tablet & Desktop */}
      <header
        style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 0.625rem)" }}
        className={`border-b px-3 sm:px-6 pb-2.5 sm:pb-3 transition-colors sticky top-0 z-30 ${
          isDark
            ? "border-zinc-900 bg-zinc-950/95 backdrop-blur-md"
            : "border-slate-200 bg-white/95 backdrop-blur-md"
        }`}
      >
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-2 sm:gap-4">
          {/* Logo & Market Badge */}
          <div className="flex items-center gap-2 shrink-0">
            <img
              src="/app-icon.png"
              alt="ThDpst Matches"
              className="h-5 w-5 rounded object-cover"
            />
            <span
              className={`text-xs sm:text-sm font-bold tracking-wider uppercase ${isDark ? "text-white" : "text-slate-900"}`}
            >
              ThDpst Matches
            </span>
            <span
              className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border transition-colors ${
                isDark
                  ? "border-zinc-700 bg-zinc-900 text-zinc-300"
                  : "border-slate-300 bg-slate-100 text-slate-700"
              }`}
            >
              {currentMarket.id}
            </span>
            <span className="hidden md:inline font-normal text-zinc-500 text-xs">
              // {currentMarket.displayName}
            </span>
          </div>

          {/* Desktop Bot Telemetry Pill (lg screens only) */}
          <div
            className={`hidden xl:flex min-w-0 items-center gap-2 border-l pl-3 text-xs ${
              isDark ? "border-zinc-800" : "border-slate-200"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  running
                    ? isDark
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-emerald-600 animate-pulse"
                    : isDark
                      ? "bg-zinc-600"
                      : "bg-slate-400"
                }`}
              />
              <span
                className={`font-semibold uppercase text-[11px] ${isDark ? "text-zinc-300" : "text-slate-800"}`}
              >
                {botState}
              </span>
            </div>
            <span className={isDark ? "text-zinc-800" : "text-slate-300"}>|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px]">P/L</span>
              <span
                className={`font-semibold num ${
                  totalPnl > 0
                    ? isDark
                      ? "text-emerald-400 font-bold"
                      : "text-emerald-600 font-bold"
                    : totalPnl < 0
                      ? isDark
                        ? "text-rose-400 font-bold"
                        : "text-rose-600 font-bold"
                      : isDark
                        ? "text-white"
                        : "text-slate-800"
                }`}
              >
                {totalPnl >= 0 ? "+" : ""}
                {totalPnl.toFixed(2)}
              </span>
            </div>
            <span className={isDark ? "text-zinc-800" : "text-slate-300"}>|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px]">TRADES</span>
              <span className={`font-semibold num ${isDark ? "text-zinc-200" : "text-slate-800"}`}>
                {trades.length}
              </span>
            </div>
          </div>

          {/* Desktop Right Header Controls (lg screens) */}
          <div className="hidden lg:flex min-w-0 flex-wrap items-center justify-end gap-2.5">
            {/* Live Balance */}
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isConnectedToDeriv
                    ? isDark
                      ? "bg-emerald-400"
                      : "bg-emerald-600"
                    : "bg-amber-400"
                }`}
              />
              <span className="text-zinc-500">{activeAccount?.currency || "USD"}</span>
              <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                {activeAccount?.balance
                  ? Number(activeAccount.balance).toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })
                  : "0.00"}
              </span>
            </div>

            {/* Account Switcher Dropdown */}
            <select
              value={activeId || ""}
              onChange={(e) => switchAccount(e.target.value)}
              className={`max-w-[220px] truncate rounded border px-2 py-1.5 text-xs font-medium outline-none transition-colors ${
                isDark
                  ? "border-zinc-800 bg-zinc-900 text-zinc-200 hover:border-zinc-700"
                  : "border-slate-300 bg-white text-slate-800 hover:border-slate-400"
              }`}
            >
              {accounts.map((acc) => (
                <option
                  key={acc.account_id}
                  value={acc.account_id}
                  className={isDark ? "bg-zinc-900 text-white" : "bg-white text-slate-900"}
                >
                  {acc.account_id} ({acc.account_type === "real" ? "Real" : "Demo"})
                  — $
                  {Number(acc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </option>
              ))}
            </select>

            {/* Notification Toggle */}
            <button
              type="button"
              onClick={toggleNotifications}
              title={
                notifsEnabled
                  ? "Alerts on — synced across your devices"
                  : "Enable alerts on this device (syncs across devices)"
              }
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                notifsEnabled
                  ? isDark
                    ? "border-zinc-600 bg-zinc-900 text-zinc-300 font-bold"
                    : "border-zinc-500 bg-zinc-100 text-zinc-800 font-bold"
                  : isDark
                    ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  notifsEnabled
                    ? isDark
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-emerald-600 animate-pulse"
                    : isDark
                      ? "bg-zinc-600"
                      : "bg-slate-400"
                }`}
              />
              <span>NOTIF: {notifsEnabled ? "ON" : "OFF"}</span>
            </button>

            {/* Audio Alert Toggle */}
            <button
              type="button"
              onClick={toggleSound}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                soundEnabled
                  ? isDark
                    ? "border-zinc-700 bg-zinc-900 text-zinc-200"
                    : "border-slate-300 bg-slate-100 text-slate-800"
                  : isDark
                    ? "border-zinc-800 text-zinc-500"
                    : "border-slate-200 text-slate-400"
              }`}
            >
              SOUND: {soundEnabled ? "ON" : "OFF"}
            </button>

            {/* PWA Install Button */}
            {!isStandalone && (installable || isIOS()) && (
              <button
                type="button"
                onClick={handleInstallApp}
                className="rounded bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
              >
                INSTALL
              </button>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                isDark
                  ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:text-slate-900"
              }`}
            >
              {isDark ? "LIGHT" : "DARK"}
            </button>

            {/* Exit */}
            <button
              onClick={() => {
                session.clear();
                clearAllDerivAuth();
                navigate({ to: "/" });
              }}
              className={`rounded border px-2 py-1.5 text-xs uppercase tracking-wider transition-colors ${
                isDark
                  ? "border-zinc-800 text-zinc-400 hover:text-white"
                  : "border-slate-300 text-slate-600 hover:text-slate-900"
              }`}
            >
              EXIT
            </button>

            {/* Desktop Action Buttons */}
            <div
              className={`flex items-center gap-1.5 pl-2 border-l ${isDark ? "border-zinc-800" : "border-slate-200"}`}
            >
              {running ? (
                <button
                  onClick={() => stopBot("User stopped bot.")}
                  className="rounded bg-rose-600 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-rose-500 transition-colors shadow-sm"
                >
                  STOP BOT
                </button>
              ) : (
                <button
                  onClick={startBot}
                  disabled={digits.length < startTickRequirement}
                  className="rounded bg-white px-4 py-2 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {digits.length < startTickRequirement
                    ? `BUFFERING (${digits.length}/${startTickRequirement})`
                    : "START BOT"}
                </button>
              )}

              <button
                onClick={resetSession}
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                RESET
              </button>

              <button
                onClick={triggerManualTestTrade}
                disabled={
                  strategyMode === "x2x" || digits.length < WINDOW || pending.current !== null
                }
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 ${
                  isDark
                    ? "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600"
                    : "border-zinc-300 bg-zinc-100 text-zinc-800"
                }`}
              >
                TEST 1
              </button>

              <button
                onClick={runBacktest1000Ticks}
                disabled={digits.length < WINDOW}
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                TEST 1K
              </button>
            </div>
          </div>

          {/* Mobile Right Controls: Compact Balance & Menu Button (< lg screens, Guaranteed Zero Overlap) */}
          <div className="flex lg:hidden items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (!isConnectedToDeriv || !activeAccount) setShowConnectModal(true);
              }}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${
                isDark
                  ? "border-zinc-800 bg-zinc-900/90 text-white"
                  : "border-slate-200 bg-slate-100 text-slate-900"
              }`}
            >
              <span
                className={`text-[9px] font-bold uppercase ${
                  !activeAccount
                    ? "text-zinc-500"
                    : activeAccount.account_type === "real"
                      ? "text-zinc-400"
                      : "text-zinc-500"
                }`}
              >
                {!activeAccount ? "Off" : activeAccount.account_type === "real" ? "Real" : "Demo"}
              </span>
              <span className="num">
                {activeAccount
                  ? `$${Number(activeAccount.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                  : "Connect"}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setShowMobileMenu(true)}
              className={`rounded border px-2.5 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                isDark
                  ? "border-zinc-800 bg-zinc-900 text-zinc-200"
                  : "border-slate-300 bg-white text-slate-800 shadow-sm"
              }`}
            >
              MENU
            </button>
          </div>
        </div>

        {/* Mobile Telemetry Sub-bar (< lg screens, Dedicated Strip, Guaranteed Zero Overlap) */}
        <div
          className={`lg:hidden border-t mt-2 pt-1.5 flex items-center justify-between text-[11px] ${
            isDark ? "border-zinc-900 text-zinc-400" : "border-slate-200 text-slate-700"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                running
                  ? isDark
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-emerald-600 animate-pulse"
                  : isDark
                    ? "bg-zinc-600"
                    : "bg-slate-400"
              }`}
            />
            <span
              className={`font-semibold uppercase text-[10px] ${isDark ? "text-zinc-300" : "text-slate-900"}`}
            >
              {botState}
            </span>
            <span className="text-[10px] opacity-75">({runCount} trades)</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase opacity-75">P/L:</span>
            <span
              className={`font-bold num ${
                totalPnl > 0
                  ? isDark
                    ? "text-emerald-400 font-bold"
                    : "text-emerald-600 font-bold"
                  : totalPnl < 0
                    ? isDark
                      ? "text-rose-400 font-bold"
                      : "text-rose-600 font-bold"
                    : isDark
                      ? "text-white"
                      : "text-slate-900"
              }`}
            >
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center gap-1 text-[10px]">
            <span className="opacity-75">{strategyMode === "x2x" ? "OP:" : "SPREAD:"}</span>
            <span
              className={`font-semibold num ${
                strategyMode === "x2x"
                  ? x2xScannerState.signal
                    ? isDark
                      ? "text-emerald-400 font-bold"
                      : "text-emerald-600 font-bold"
                    : isDark
                      ? "text-zinc-400"
                      : "text-slate-600"
                  : analysis.ok
                    ? isDark
                      ? "text-emerald-400 font-bold"
                      : "text-emerald-600 font-bold"
                    : isDark
                      ? "text-zinc-400"
                      : "text-slate-600"
              }`}
            >
              {strategyMode === "x2x"
                ? (x2xScannerState.signal?.opTrigger ?? "--")
                : `${analysis.diff.toFixed(2)}%`}
            </span>
          </div>
        </div>
      </header>

      {/* 2. Main Content Container (Padded bottom on mobile for sticky bottom bar) */}
      <main className="mx-auto max-w-[1560px] p-3 sm:p-4 lg:p-6 pb-36 lg:pb-6">
        {/* Mobile Segmented Control Tab Switcher (< lg screens) */}
        <div
          className={`lg:hidden mb-4 grid grid-cols-4 gap-1 p-1 rounded-xl border text-[11px] font-bold uppercase tracking-wider ${
            isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white shadow-sm"
          }`}
        >
          {(["market", "controls", "session", "all"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMobileTab(tab)}
              className={`py-2 text-center rounded-lg transition-all ${
                mobileTab === tab
                  ? isDark
                    ? "bg-zinc-800 text-zinc-300 font-bold shadow-sm"
                    : "bg-slate-900 text-white font-bold shadow-sm"
                  : isDark
                    ? "text-zinc-500 hover:text-zinc-300"
                    : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {tab === "market"
                ? "Market"
                : tab === "controls"
                  ? "Controls"
                  : tab === "session"
                    ? "Session"
                    : "All"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr_290px] gap-5 lg:gap-6 items-start">
          {/* LEFT COLUMN: Controls & Settings */}
          <aside
            className={`space-y-5 lg:space-y-6 ${mobileTab === "controls" || mobileTab === "all" ? "block" : "hidden lg:block"}`}
          >
            {/* CONNECTION */}
            <section
              className={`rounded-xl border p-4 space-y-3 shadow-sm ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  CONNECTION
                </span>
                {isConnectedToDeriv && (
                  <button
                    onClick={resetDemoBalance}
                    title="Sync balance from Deriv"
                    className="text-[10px] text-zinc-400 hover:underline uppercase font-bold"
                  >
                    SYNC BALANCE
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Active Account (Tap to Switch)</label>
                <div
                  onClick={toggleDemoReal}
                  title="Click to toggle Real / Demo"
                  className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                    isDark
                      ? "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                      : "border-slate-200 bg-slate-50 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className={isDark ? "text-white" : "text-slate-900"}>
                      {activeAccount?.account_id || "Not connected"}{" "}
                      {activeAccount ? `(${activeType === "real" ? "Real" : "Demo"})` : ""}
                    </span>
                    <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                      $
                      {Number(activeAccount?.balance || 0).toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500 leading-tight">
                    {tradingReady
                      ? "Live Deriv balance. Updates after every trade."
                      : isConnectedToDeriv
                        ? "Signed in. Opening the trading connection..."
                        : "Connect Deriv so each trade moves your real balance."}
                  </p>
                  {tradingStatusNote && (
                    <p className="mt-1 text-[10px] text-zinc-600 leading-tight">
                      {tradingStatusNote}
                    </p>
                  )}
                </div>
              </div>

              {isConnectedToDeriv ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      disabled
                      className={`flex-1 rounded border py-2 text-xs font-medium uppercase tracking-wider ${
                        tradingReady
                          ? isDark
                            ? "border-zinc-700 bg-zinc-900/60 text-zinc-300"
                            : "border-zinc-200 bg-zinc-100 text-zinc-700"
                          : isDark
                            ? "border-amber-900/60 bg-amber-950/30 text-amber-400"
                            : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {tradingReady
                        ? "LIVE TRADING"
                        : "AUTHED · SOCKET…"}
                    </button>
                    <button
                      onClick={refreshDerivBalances}
                      title="Sync latest balances from Deriv"
                      className={`rounded border px-3 py-2 text-xs uppercase tracking-wider transition-colors ${
                        isDark
                          ? "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-white"
                          : "border-slate-300 text-slate-600 hover:border-slate-400"
                      }`}
                    >
                      SYNC
                    </button>
                  </div>
                  <button
                    onClick={() => setShowConnectModal(true)}
                    className="w-full text-center text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-wider"
                  >
                    Change Account
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowConnectModal(true)}
                  className="w-full rounded bg-white py-2.5 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
                >
                  CONNECT DERIV ACCOUNT
                </button>
              )}
            </section>

            {/* STRATEGY (Strict Matches Strategy) */}
            <section
              className={`rounded-xl border p-4 space-y-4 shadow-sm ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                STRATEGY
              </span>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Trading Strategy</label>
                <div
                  className={`grid grid-cols-2 gap-1 rounded border p-0.5 ${
                    isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-100"
                  }`}
                >
                  {(["matches", "x2x"] as const).map((mode) => {
                    const selected = strategyMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={running}
                        onClick={() => handleSelectStrategy(mode)}
                        className={`rounded py-1.5 px-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
                          selected
                            ? isDark
                              ? "bg-zinc-800 text-white shadow-sm"
                              : "bg-white text-slate-900 shadow-sm"
                            : "text-zinc-500 hover:text-zinc-900"
                        }`}
                      >
                        {mode === "matches" ? "Matches" : "X2X Sniper"}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-zinc-500">Contract & Market</label>
                  <span className="text-[10px] text-zinc-500">
                    {strategyMode === "x2x"
                      ? "X2X · DIGITMATCH · 1 TICK"
                      : "Matches · DIGITMATCH"}
                  </span>
                </div>
                <div
                  className={`grid grid-cols-2 gap-1 rounded border p-0.5 ${
                    isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-100"
                  }`}
                >
                  {MARKET_LIST.map((m) => {
                    const isSelected = marketSymbol === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={running}
                        onClick={() => handleSelectMarket(m.id)}
                        className={`rounded py-1.5 px-2 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                          isSelected
                            ? isDark
                              ? "bg-zinc-800 text-white shadow-sm"
                              : "bg-white text-slate-900 shadow-sm"
                            : "text-zinc-500 hover:text-white disabled:opacity-40"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isSelected ? "bg-emerald-400" : "bg-zinc-600"
                          }`}
                        />
                        <span>{m.shortName}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  {strategyMode === "x2x"
                    ? `On ${currentMarket.displayName}: detect three consecutive last digits X-2-X, store the following tick digit as LDP, then wait for the pattern quote's last two displayed digits minus 20.`
                    : `Enter on the most appearing digit only when the spread exactly equals ${maxDiff}% on ${currentMarket.displayName} (${marketPipDecimals} decimals).`}
                </p>
              </div>

              {strategyMode === "x2x" && (
                <div
                  className={`rounded-lg border p-3 space-y-1.5 ${
                    isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    X2X LIVE SCAN
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {currentMarket.displayName} · DIGITMATCH · 1 tick
                    · Stake ${stake.toFixed(2)}
                  </div>
                  <div
                    className={`font-mono text-xs ${isDark ? "text-zinc-200" : "text-zinc-800"}`}
                  >
                    {x2xScannerState.recentDigits.length > 0
                      ? x2xScannerState.recentDigits.join(
                          " → ",
                        )
                      : "Waiting for live ticks"}
                  </div>
                  <div className="text-[10px] leading-relaxed text-zinc-500">
                    {x2xScannerState.signal?.phase === "awaiting-ldp"
                      ? `Pattern ${x2xScannerState.signal.pattern} detected; next tick supplies LDP. Reference ${x2xScannerState.signal.referencePair} → OP ${x2xScannerState.signal.opTrigger}.`
                      : x2xScannerState.signal?.phase === "awaiting-op"
                        ? x2xScannerState.signal.eligibleTicksLimit === null
                          ? `LDP ${x2xScannerState.signal.ldp}; watching for quote suffix ${x2xScannerState.signal.opTrigger} with no expiry (${x2xScannerState.signal.eligibleTicksElapsed} eligible ticks observed).`
                          : `LDP ${x2xScannerState.signal.ldp}; watching for quote suffix ${x2xScannerState.signal.opTrigger} across ${x2xScannerState.signal.eligibleTicksRemaining} eligible ticks.`
                        : "Scanning consecutive live tick digits for X2X."}
                  </div>
                  <div
                    className={`flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-2 ${
                      isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
                    }`}
                  >
                    <label className="flex items-center gap-2 text-[10px] font-semibold text-zinc-500">
                      <input
                        type="checkbox"
                        checked={x2xOpWaitTicks === null}
                        onChange={(event) =>
                          updateX2XOpWaitTicks(event.target.checked ? null : X2X_OP_WINDOW_TICKS)
                        }
                        className="accent-emerald-500"
                      />
                      No expiry
                    </label>
                    <label className="flex items-center gap-2 text-[10px] text-zinc-500">
                      Wait ticks
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={X2X_MAX_OP_WAIT_TICKS}
                        step={1}
                        value={x2xOpWaitTicksInput}
                        disabled={x2xOpWaitTicks === null}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (!/^[0-9]*$/.test(value)) return;
                          setX2xOpWaitTicksInput(value);
                          const parsed = Number(value);
                          if (value && parsed >= 1 && parsed <= X2X_MAX_OP_WAIT_TICKS) {
                            updateX2XOpWaitTicks(parsed);
                          }
                        }}
                        onBlur={() =>
                          setX2xOpWaitTicksInput(
                            x2xOpWaitTicks === null ? "" : String(x2xOpWaitTicks),
                          )
                        }
                        className={`w-20 rounded border px-2 py-1 text-right font-mono text-xs outline-none disabled:opacity-40 ${
                          isDark
                            ? "border-zinc-800 bg-black text-zinc-200"
                            : "border-slate-300 bg-white text-slate-800"
                        }`}
                      />
                    </label>
                  </div>
                  <div className="text-[10px] leading-relaxed text-zinc-600">
                    Choose a tick limit or no expiry for testing. Only eligible OP ticks count; the setting applies to new signals.
                  </div>
                  <div className="text-[10px] leading-relaxed text-zinc-600">
                    One signal is tracked at a time; patterns seen before it ends are ignored. OP
                    ticks pause while a contract is open, during loss cooldown, or while trading
                    reconnects. References below 20 are rejected because subtracting 20 is negative.
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2 pt-1">
                    {[
                      ["Signals", x2xSignals.length],
                      ["Triggers", x2xTriggeredCount],
                      ["Submissions", x2xSubmittedCount],
                      ["Contracts", x2xExecutedCount],
                      ["W / L", `${x2xWins} / ${x2xLosses}`],
                      ["Win rate", `${x2xWinRate}%`],
                      ["Expired", x2xExpiredCount],
                      ["Reject / cancel", x2xRejectedCount],
                    ].map(([label, value]) => (
                      <div
                        key={String(label)}
                        className={`rounded border px-2 py-1 ${
                          isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="text-[9px] uppercase tracking-wider text-zinc-500">
                          {label}
                        </div>
                        <div className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  {x2xSignals.length > 0 && (
                    <div className="max-h-40 overflow-y-auto divide-y divide-zinc-200 dark:divide-zinc-900">
                      {x2xSignals.slice(0, 8).map((signal) => (
                        <div
                          key={signal.signalId}
                          className="grid grid-cols-[1fr_auto] gap-x-2 py-1.5 text-[10px]"
                        >
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">
                            {signal.pattern} · {signal.referencePair}{" "}
                            →{" "}
                            {signal.opTrigger ?? "rejected"}
                            {signal.ldp === null ? "" : ` · LDP ${signal.ldp}`}
                          </span>
                          <span className="text-right uppercase text-zinc-500">
                            {signal.status.replaceAll("_", " ")}
                          </span>
                          <span className="text-zinc-500">
                            {new Date(signal.detectedAt).toLocaleTimeString()} ·{" "}
                            {formatX2XWaitProgress(signal.eligibleTicksElapsed, signal.eligibleTicksLimit)}
                            {signal.status === "cancelled" && signal.cancelledAt
                              ? " | cancelled ${new Date(signal.cancelledAt).toLocaleString()}"
                              : ""}
                            {` · ${signal.contractDuration} tick`}
                            {signal.contractId
                              ? ` · contract ${signal.contractId}`
                              : ""}
                          </span>
                          <span className="text-zinc-500">
                            Source:{" "}
                            {signal.patternTickTimestamps
                              .map(
                                (timestamp, index) =>
                                  `${new Date(timestamp).toLocaleTimeString()} ${signal.patternQuotes[index]?.toFixed(2) ?? "--"}`,
                              )
                              .join(" → ")}
                          </span>
                          {signal.reason && (
                            <span className="text-right text-zinc-500">{signal.reason}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {strategyMode === "matches" && (
                <>
                  {/* Spread Threshold Δ Selector */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500">
                        Exact Spread Δ Target
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-zinc-500 text-[10px]">
                          Δ =
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={maxDiffInput}
                          onChange={(e) => {
                            const val = normalizeDecimalInput(e.target.value);
                            if (isDecimalInput(val)) {
                              setMaxDiffInput(val);
                              const num = parseDecimalInput(val);
                              if (!isNaN(num) && num >= 0) {
                                setMaxDiff(num);
                              }
                            }
                          }}
                          onBlur={() => {
                            const num = parseDecimalInput(maxDiffInput);
                            if (isNaN(num) || num < 0.1) {
                              updateMaxDiff(MAX_DIFF);
                            } else {
                              updateMaxDiff(num);
                            }
                          }}
                          className={`w-14 rounded border px-1.5 py-0.5 text-right text-xs font-bold num outline-none ${
                            isDark
                              ? "border-zinc-800 bg-black text-zinc-300 focus:border-zinc-600"
                              : "border-slate-300 bg-white text-zinc-700 focus:border-slate-500"
                          }`}
                        />
                        <span className="text-zinc-500 text-[10px]">%</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {[0.3, 0.5, 1.0, 1.5].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => updateMaxDiff(val)}
                          className={`rounded border py-1.5 text-[10px] font-semibold transition-colors ${
                            maxDiff === val
                              ? isDark
                                ? "border-zinc-500 bg-zinc-1000/20 text-zinc-300 font-bold"
                                : "border-zinc-600 bg-zinc-100 text-zinc-800 font-bold"
                              : isDark
                                ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
                                : "border-slate-200 bg-slate-100 text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          {`${val}%`}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-tight">
                      The spread must equal {maxDiff}%. With 1,000 ticks, observed spread
                      differences move in 0.1% steps.
                    </p>
                  </div>
                </>
              )}

              {/* Loss Protection Toggle */}
              <div
                className={`rounded-lg border p-3 space-y-2 ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-semibold ${isDark ? "text-zinc-300" : "text-slate-800"}`}
                  >
                    Loss Protection
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      isDark ? "bg-zinc-800 text-zinc-400" : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    ACTIVE
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reAnalyzeOnLoss}
                    onChange={(e) => setReAnalyzeOnLoss(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-white focus:ring-zinc-400"
                  />
                  <span
                    className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}
                  >
                    Re-analyze after loss
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stopOnWin}
                    onChange={(e) => setStopOnWin(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-white focus:ring-zinc-400"
                  />
                  <span
                    className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}
                  >
                    Stop after first win
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={martingaleEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setMartingaleEnabled(enabled);
                      if (!enabled) lossStreakRef.current = 0;
                    }}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-white focus:ring-zinc-400"
                  />
                  <span
                    className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}
                  >
                    1.5× martingale after losses
                  </span>
                </label>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  {martingaleEnabled
                    ? `Next stake: $${calculateMartingaleStake(stake, lossStreakRef.current, true).toFixed(2)}. It grows by ${MARTINGALE_MULTIPLIER}× after each loss and resets to the base stake after a win; this raises risk and cannot guarantee recovery.`
                    : "Re-analyzes after a loss. Turn on 1.5× martingale to increase the next stake after each loss; a win resets it to your base stake."}
                  {stopOnWin ? ' "Stop after first win" stops the bot after a win.' : ""}
                </p>
              </div>

              {/* Stake */}
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Stake (USD)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={stakeInput}
                  onChange={(e) => {
                    const val = normalizeDecimalInput(e.target.value);
                    if (isDecimalInput(val)) {
                      setStakeInput(val);
                      const num = parseDecimalInput(val);
                      if (!isNaN(num) && num > 0) {
                        setStake(num);
                      }
                    }
                  }}
                  onBlur={() => {
                    const num = parseDecimalInput(stakeInput);
                    if (isNaN(num) || num < 0.35) {
                      updateStake(0.35);
                    } else {
                      updateStake(num);
                    }
                  }}
                  className={`w-full rounded border px-3 py-2 text-sm font-semibold num outline-none ${
                    isDark
                      ? "border-zinc-800 bg-black text-white focus:border-zinc-600"
                      : "border-slate-300 bg-white text-slate-900 focus:border-slate-500"
                  }`}
                />
              </div>

              {/* Stake Quick Percentages based on Auto-updating Balance */}
              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      const bal = activeAccount ? Number(activeAccount.balance) : 0;
                      if (!Number.isFinite(bal) || bal <= 0) {
                        setNote("Balance is 0. Top up demo funds in Deriv, then sync.");
                        return;
                      }
                      const calculated = Math.max(0.35, Math.round(bal * (pct / 100) * 100) / 100);
                      updateStake(calculated);
                    }}
                    className={`rounded border py-1.5 text-[10px] font-semibold transition-colors ${
                      isDark
                        ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-white"
                        : "border-slate-200 bg-slate-100 text-slate-600 hover:border-slate-300 hover:text-slate-900"
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </section>

            {/* RISK */}
            <section
              className={`rounded-xl border p-4 space-y-3 shadow-sm ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                RISK
              </span>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-500">Take Profit ($)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={running}
                    value={tpInput}
                    onChange={(e) => {
                      const val = normalizeDecimalInput(e.target.value);
                      if (isDecimalInput(val)) {
                        setTpInput(val);
                        const num = parseDecimalInput(val);
                        if (!isNaN(num) && num > 0) {
                          setTp(num);
                        }
                      }
                    }}
                    onBlur={() => {
                      const num = parseDecimalInput(tpInput);
                      if (isNaN(num) || num < 1) {
                        updateTp(1);
                      } else {
                        updateTp(num);
                      }
                    }}
                    className={`w-full rounded border px-3 py-1.5 text-xs font-semibold num outline-none ${
                      isDark
                        ? "border-zinc-800 bg-black text-white focus:border-zinc-600"
                        : "border-slate-300 bg-white text-slate-900 focus:border-slate-500"
                    }`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-zinc-500">Stop Loss ($)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={running}
                    value={slInput}
                    onChange={(e) => {
                      const val = normalizeDecimalInput(e.target.value);
                      if (isDecimalInput(val)) {
                        setSlInput(val);
                        const num = parseDecimalInput(val);
                        if (!isNaN(num) && num > 0) {
                          setSl(num);
                        }
                      }
                    }}
                    onBlur={() => {
                      const num = parseDecimalInput(slInput);
                      if (isNaN(num) || num < 1) {
                        updateSl(1);
                      } else {
                        updateSl(num);
                      }
                    }}
                    className={`w-full rounded border px-3 py-1.5 text-xs font-semibold num outline-none ${
                      isDark
                        ? "border-zinc-800 bg-black text-white focus:border-zinc-600"
                        : "border-slate-300 bg-white text-slate-900 focus:border-slate-500"
                    }`}
                  />
                </div>
              </div>
            </section>
          </aside>

          {/* CENTER COLUMN: Last Digit, Tick Stream & Trade Log */}
          <div
            className={`space-y-5 lg:space-y-6 min-w-0 ${mobileTab === "market" || mobileTab === "all" ? "block" : "hidden lg:block"}`}
          >
            {/* Top Row: Last Digit & Tick Stream Side by Side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
              {/* CARD 1: LAST DIGIT */}
              <section
                className={`rounded-xl border p-4 sm:p-5 shadow-sm space-y-4 ${
                  isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
                }`}
              >
                {/* Header */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                      LAST DIGIT
                    </span>
                    <span className="max-w-[60%] text-right text-[11px] font-semibold leading-tight text-zinc-500">
                      {currentMarket.displayName}
                    </span>
                  </div>

                  {/* Quick Market Toggle Pills */}
                  <div
                    className={
                      "flex w-full flex-wrap gap-0.5 rounded border p-0.5 " +
                      (isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-100")
                    }
                  >
                    {MARKET_LIST.map((m) => {
                      const isSelected = marketSymbol === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={running}
                          onClick={() => handleSelectMarket(m.id)}
                          className={
                            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-[10px] font-bold uppercase transition-colors " +
                            (isSelected
                              ? isDark
                                ? "bg-zinc-800 text-white shadow-sm"
                                : "bg-white text-slate-900 shadow-sm"
                              : "text-zinc-500 hover:text-white disabled:opacity-40")
                          }
                        >
                          <span
                            className={
                              "h-1 w-1 rounded-full " +
                              (isSelected ? "bg-emerald-400" : "bg-zinc-600")
                            }
                          />
                          {m.id}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="text-[10px] text-zinc-500">PRICE</div>
                      <div
                        className={
                          "text-sm font-bold num " + (isDark ? "text-white" : "text-slate-900")
                        }
                      >
                        {price !== null
                          ? price.toFixed(marketPipDecimals)
                          : "—"}
                      </div>
                    </div>
                    {strategyMode === "matches" && (
                      <div className="max-w-[65%] text-right">
                        <div
                          className={
                            "text-[11px] font-semibold num " +
                            (analysis.ok
                              ? isDark
                                ? "text-emerald-400 font-bold"
                                : "text-emerald-600 font-bold"
                              : isDark
                                ? "text-zinc-400"
                                : "text-slate-600")
                          }
                        >
                          SPREAD Δ {analysis.diff.toFixed(2)}%{" "}
                          <span className="opacity-60">= {maxDiff}% target</span>
                        </div>
                        <div
                          className={
                            "text-[10px] font-semibold " +
                            (analysis.ok
                              ? isDark
                                ? "text-emerald-400"
                                : "text-emerald-600"
                              : isDark
                                ? "text-zinc-400"
                                : "text-slate-600")
                          }
                        >
                          {analysis.ok ? "(READY)" : "(WAITING)"}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {/* Giant Digit Display */}
                <div className="flex items-baseline gap-4">
                  <span
                    className={`text-6xl sm:text-7xl font-light tracking-tight num ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {currentDigit !== undefined
                      ? currentDigit
                      : "—"}
                  </span>
                  <div className="space-y-0.5 text-xs">
                    <div className="text-zinc-500">
                      ENTRY DIGIT:{" "}
                      <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                        {analysis.most}
                      </span>{" "}
                      ({analysis.mostPct.toFixed(1)}%)
                    </div>
                    <div className="text-zinc-500">
                      MATCH TARGET:{" "}
                      <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                        {analysis.second}
                      </span>{" "}
                      ({analysis.secondPct.toFixed(1)}%)
                    </div>
                  </div>
                </div>

                {/* Chronological Digit Tiles: strictly numbers as they arrive from Deriv */}
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase text-zinc-500 pb-1">
                    <span>Live Sequence (Chronological)</span>
                    <span className="text-zinc-400 font-semibold uppercase">LATEST</span>
                  </div>

                  <div className="grid grid-cols-11 gap-1 text-center text-xs num">
                    {recentDigits33.slice(0, 11).map((d, i) => (
                      <span
                        key={i}
                        className={`rounded border py-1 font-semibold ${
                          isDark
                            ? "border-zinc-800 bg-zinc-900 text-zinc-300"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700"
                        }`}
                      >
                        {d}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-11 gap-1 text-center text-xs num">
                    {recentDigits33.slice(11, 22).map((d, i) => (
                      <span
                        key={i + 11}
                        className={`rounded border py-1 font-semibold ${
                          isDark
                            ? "border-zinc-800 bg-zinc-900 text-zinc-300"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700"
                        }`}
                      >
                        {d}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-11 gap-1 text-center text-xs num">
                    {recentDigits33.slice(22, 33).map((d, i) => {
                      const isLatest = i + 22 === recentDigits33.length - 1;
                      return (
                        <span
                          key={i + 22}
                          className={`rounded border py-1 font-semibold transition-all ${
                            isLatest
                              ? isDark
                                ? "border-zinc-100 bg-zinc-100 text-zinc-950 font-bold ring-2 ring-zinc-700"
                                : "border-zinc-900 bg-zinc-900 text-white font-bold ring-2 ring-zinc-400"
                              : isDark
                                ? "border-zinc-800 bg-zinc-900 text-zinc-300"
                                : "border-zinc-200 bg-zinc-50 text-zinc-700"
                          }`}
                        >
                          {d}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* CARD 2: TICK STREAM */}
              <section
                className={`rounded-xl border p-4 sm:p-5 shadow-sm space-y-3 ${
                  isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
                }`}
              >
                <div
                  className={`flex items-center justify-between border-b pb-2 ${
                    isDark ? "border-zinc-900" : "border-slate-200"
                  }`}
                >
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    TICK STREAM
                  </span>
                  <span className="text-[10px] text-zinc-500 num">
                    {digits.length >= WINDOW
                      ? "1,000 / 1,000 (READY)"
                      : `${digits.length} / ${WINDOW} (BUFFERING)`}
                  </span>
                </div>

                <div className="overflow-hidden text-xs num">
                  <table className="w-full text-left">
                    <tbody
                      className={`divide-y ${isDark ? "divide-zinc-900" : "divide-slate-100"}`}
                    >
                      {recentTicks.slice(0, 13).map((tick, idx) => (
                        <tr
                          key={idx}
                          className={isDark ? "hover:bg-zinc-900/50" : "hover:bg-slate-50"}
                        >
                          <td className="py-1 text-zinc-500 text-[11px]">{tick.time}</td>
                          <td
                            className={`py-1 font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}
                          >
                            {tick.price.toFixed(marketPipDecimals)}
                          </td>
                          <td className="py-1 text-right font-bold">
                            <span
                              className={`inline-block px-1.5 py-0.2 rounded text-[11px] ${
                                idx === 0
                                  ? isDark
                                    ? "bg-white text-black font-bold"
                                    : "bg-slate-900 text-white font-bold"
                                  : "text-zinc-400"
                              }`}
                            >
                              -{tick.digit}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            {/* Adaptive next-digit predictor */}
            <section
              hidden
              className={`rounded-xl border p-4 sm:p-5 shadow-sm space-y-4 ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <div
                className={`flex flex-wrap items-start justify-between gap-3 border-b pb-3 ${
                  isDark ? "border-zinc-900" : "border-slate-200"
                }`}
              >
                <div>
                  <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    NEXT DIGIT FORECAST
                  </h2>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Adaptive pattern model trained on the latest 1,000 ticks.
                  </p>
                </div>
                <span
                  className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                    nextPrediction
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-500"
                  }`}
                >
                  {nextPrediction
                    ? "MODEL READY"
                    : `TRAINING ${Math.min(digits.length, WINDOW)}/${WINDOW}`}
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-[minmax(140px,0.7fr)_2fr]">
                <div
                  className={`flex flex-col items-center justify-center rounded-lg border p-4 text-center ${
                    isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    PREDICTED NEXT DIGIT
                  </span>
                  <span
                    className={`my-1 text-6xl font-light num ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {nextPrediction?.digit ?? "—"}
                  </span>
                  <span className="text-[11px] text-zinc-500">
                    Estimated chance{" "}
                    {nextPrediction
                      ? `${nextPrediction.confidence.toFixed(1)}%`
                      : "—"}
                  </span>
                  <span className="mt-2 text-[10px] uppercase tracking-wide text-zinc-500">
                    {nextPrediction?.method ?? "Awaiting 1,000 ticks"}
                  </span>
                  {nextPrediction && nextPrediction.method !== "all-digit frequency" && (
                    <span className="text-[10px] text-zinc-600">
                      {nextPrediction.contextSamples} digits in this frequency window
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div
                    className={`rounded-lg border p-3 ${isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"}`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                      LIVE ACCURACY
                    </div>
                    <div
                      className={`mt-1 text-2xl font-semibold num ${isDark ? "text-white" : "text-slate-900"}`}
                    >
                      {predictionAccuracy === null
                        ? "—"
                        : `${predictionAccuracy}%`}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {predictionStats.correct} correct / {predictionStats.forecasts} scored
                    </div>
                  </div>
                  <div
                    className={`rounded-lg border p-3 ${isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"}`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                      LAST 100
                    </div>
                    <div
                      className={`mt-1 text-2xl font-semibold num ${isDark ? "text-white" : "text-slate-900"}`}
                    >
                      {recentPredictionAccuracy === null
                        ? "—"
                        : `${recentPredictionAccuracy}%`}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {predictionStats.recentResults.length} recent live ticks
                    </div>
                  </div>
                  <div
                    className={`rounded-lg border p-3 ${isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"}`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                      MISSES
                    </div>
                    <div
                      className={`mt-1 text-2xl font-semibold num ${isDark ? "text-white" : "text-slate-900"}`}
                    >
                      {predictionStats.forecasts - predictionStats.correct}
                    </div>
                    <div className="text-[10px] text-zinc-500">Exact digit matches only</div>
                  </div>
                  <div
                    className={`rounded-lg border p-3 ${isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"}`}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                      CURRENT STREAK
                    </div>
                    <div
                      className={`mt-1 text-2xl font-semibold num ${isDark ? "text-white" : "text-slate-900"}`}
                    >
                      {predictionStats.currentStreak}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {predictionStats.lastResult === null
                        ? "Waiting for the first live tick"
                        : predictionStats.lastResult
                          ? "consecutive correct"
                          : "consecutive missed"}
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-[10px] leading-relaxed text-zinc-500">
                The model counts each digit across the latest 1,000 ticks and checks two
                recency-weighted frequency views. It does not use digit pairs or transitions.
              </p>
              <p className="text-[10px] leading-relaxed text-zinc-500">
                Past replay:{" "}
                {nextPrediction
                  ? nextPrediction.selectedStrategy +
                    " " +
                    nextPrediction.validationAccuracy +
                    "% vs all-digit frequency " +
                    nextPrediction.baselineAccuracy +
                    "% across " +
                    nextPrediction.validationForecasts +
                    " ticks."
                  : "Waiting for 1,000 ticks."}{" "}
                {nextPrediction?.edgeDetected
                  ? "A recency-based frequency model cleared the replay margin."
                  : "No recency-based model beat all-digit frequency by the replay margin."}{" "}
                Live accuracy is scored separately; historical performance cannot guarantee future
                results. A 60-70% exact-digit rate is not a credible promise for a random 10-digit
                outcome.
              </p>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    LIVE FORECAST CHECKS
                  </h3>
                  <span className="text-[10px] text-zinc-500">Latest {scoredTicks.length}</span>
                </div>
                {scoredTicks.length === 0 ? (
                  <div
                    className={`rounded-lg border px-3 py-4 text-center text-xs text-zinc-500 ${isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"}`}
                  >
                    Live tick predictions will be scored here after the model trains.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[440px] text-left text-[10px] num">
                      <thead>
                        <tr
                          className={`border-b uppercase tracking-wide text-zinc-500 ${isDark ? "border-zinc-900" : "border-slate-200"}`}
                        >
                          <th className="py-2 pr-2">Time</th>
                          <th className="py-2 pr-2">Quote</th>
                          <th className="py-2 pr-2">Actual</th>
                          <th className="py-2 pr-2">Forecast</th>
                          <th className="py-2 text-right">Result</th>
                        </tr>
                      </thead>
                      <tbody
                        className={`divide-y ${isDark ? "divide-zinc-900" : "divide-slate-100"}`}
                      >
                        {scoredTicks.map((tick, index) => (
                          <tr key={`${tick.time}-${index}`}>
                            <td className="py-2 pr-2 text-zinc-500">{tick.time}</td>
                            <td
                              className={`py-2 pr-2 ${isDark ? "text-zinc-300" : "text-slate-700"}`}
                            >
                              {tick.price.toFixed(marketPipDecimals)}
                            </td>
                            <td
                              className={`py-2 pr-2 font-bold ${isDark ? "text-white" : "text-slate-900"}`}
                            >
                              {tick.digit}
                            </td>
                            <td className="py-2 pr-2">{tick.predictedDigit}</td>
                            <td
                              className={`py-2 text-right font-bold ${tick.predictionCorrect ? "text-emerald-500" : "text-rose-500"}`}
                            >
                              {tick.predictionCorrect ? "CORRECT" : "MISSED"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>

            {/* Bottom Row: TRADE LOG / SESSION HISTORY */}
            <section
              className={`rounded-xl border shadow-sm ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <div
                className={`flex items-center justify-between border-b px-4 sm:px-5 py-3 ${
                  isDark ? "border-zinc-900" : "border-slate-200"
                }`}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCenterTab("trade_log")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "trade_log"
                        ? isDark
                          ? "bg-zinc-800 text-white"
                          : "bg-slate-200 text-slate-900 font-bold"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    TRADE LOG
                  </button>
                  <button
                    onClick={() => setCenterTab("session_history")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "session_history"
                        ? isDark
                          ? "bg-zinc-800 text-white"
                          : "bg-slate-200 text-slate-900 font-bold"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    HISTORY
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={saveCurrentSession}
                    disabled={running || (trades.length === 0 && x2xSignals.length === 0)}
                    title={
                      running
                        ? "Stop the bot before saving and clearing this session"
                        : "Save session and clear current trades"
                    }
                    className={
                      "rounded border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
                      (isDark
                        ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                        : "border-slate-300 bg-white text-slate-700 hover:text-slate-900")
                    }
                  >
                    SAVE SESSION
                  </button>
                  <span className="text-xs text-zinc-500 num">
                    {centerTab === "trade_log"
                      ? trades.length + " trades"
                      : savedSessions.length + " saved"}
                  </span>
                </div>
              </div>

              <div className="p-4 sm:p-6">
                {centerTab === "trade_log" ? (
                  <>
                    {trades.length === 0 ? (
                      <div className="py-12 sm:py-16 text-center">
                        <p className={`text-xs ${isDark ? "text-zinc-600" : "text-slate-400"}`}>
                          Trades will appear here once the bot fires.
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto text-xs num">
                        <table className="w-full text-left">
                          <thead>
                            <tr
                              className={`border-b text-zinc-500 pb-2 uppercase text-[10px] ${
                                isDark ? "border-zinc-900" : "border-slate-200"
                              }`}
                            >
                              <th className="py-2">Run</th>
                              <th>Time</th>
                              <th>Entry</th>
                              <th>Target</th>
                              <th>Exit</th>
                              <th>Stake</th>
                              <th>Status</th>
                              <th>Contract</th>
                              <th className="text-right">P/L</th>
                            </tr>
                          </thead>
                          <tbody
                            className={`divide-y ${isDark ? "divide-zinc-900" : "divide-slate-100"}`}
                          >
                            {trades.map((t) => (
                              <tr
                                key={t.id}
                                className={isDark ? "hover:bg-zinc-900/40" : "hover:bg-slate-50"}
                              >
                                <td
                                  className={`py-2.5 font-bold ${isDark ? "text-white" : "text-slate-900"}`}
                                >
                                  #{t.runIndex}
                                </td>
                                <td className="text-zinc-500">{t.time}</td>
                                <td>{t.entry}</td>
                                <td
                                  className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}
                                >
                                  {t.target}
                                </td>
                                <td
                                  className={`font-bold ${isDark ? "text-white" : "text-slate-900"}`}
                                >
                                  {t.result}
                                </td>
                                <td>${t.stake.toFixed(2)}</td>
                                <td>
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                      t.pnl > 0
                                        ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                                        : "bg-red-500/15 text-red-500 border border-red-500/40"
                                    }`}
                                  >
                                    {t.pnl > 0 ? "WON" : "LOST"}
                                  </span>
                                </td>
                                <td className="text-zinc-500" title={t.signalId}>
                                  {t.contractId ?? "--"}
                                </td>
                                <td
                                  className={`text-right font-bold ${
                                    t.pnl > 0 ? "text-emerald-500" : "text-red-500"
                                  }`}
                                >
                                  {t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : savedSessions.length === 0 ? (
                  <div className="py-12 sm:py-16 text-center">
                    <p className={"text-xs " + (isDark ? "text-zinc-400" : "text-slate-600")}>
                      No saved sessions yet.
                    </p>
                    <p className="mt-2 text-xs text-zinc-500">
                      Saving stores the completed session in history and clears its current trades.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {savedSessions.map((saved) => (
                      <article
                        key={saved.id}
                        className={
                          "rounded-lg border p-3 sm:p-4 " +
                          (isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50")
                        }
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div
                              className={
                                "text-sm font-semibold " +
                                (isDark ? "text-white" : "text-slate-900")
                              }
                            >
                              {saved.strategyMode === "x2x" ? "X2X Sniper / " : ""}
                              {MARKETS[saved.marketSymbol].displayName}
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              {new Date(saved.savedAt).toLocaleString()} ·{" "}
                              {MARKETS[saved.marketSymbol].classicSymbol}
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-expanded={expandedHistoryId === saved.id}
                            onClick={() =>
                              setExpandedHistoryId((current) =>
                                current === saved.id ? null : saved.id,
                              )
                            }
                            className={
                              "rounded border px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider " +
                              (isDark
                                ? "border-zinc-700 text-zinc-300 hover:bg-zinc-900"
                                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100")
                            }
                          >
                            {expandedHistoryId === saved.id ? "HIDE TRADES" : "VIEW TRADES"}
                          </button>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div
                            className={
                              "rounded border p-2 " +
                              (isDark ? "border-zinc-800" : "border-slate-200 bg-white")
                            }
                          >
                            <div className="text-[10px] text-zinc-500">NET P/L</div>
                            <div
                              className={
                                "mt-1 text-sm font-semibold num " +
                                (saved.totalPnl >= 0 ? "text-emerald-500" : "text-red-500")
                              }
                            >
                              {saved.totalPnl >= 0 ? "+" : ""}
                              {saved.totalPnl.toFixed(2)} USD
                            </div>
                          </div>
                          <div
                            className={
                              "rounded border p-2 " +
                              (isDark ? "border-zinc-800" : "border-slate-200 bg-white")
                            }
                          >
                            <div className="text-[10px] text-zinc-500">TRADES</div>
                            <div
                              className={
                                "mt-1 text-sm font-semibold num " +
                                (isDark ? "text-white" : "text-slate-900")
                              }
                            >
                              {saved.trades.length}
                            </div>
                          </div>
                          <div
                            className={
                              "rounded border p-2 " +
                              (isDark ? "border-zinc-800" : "border-slate-200 bg-white")
                            }
                          >
                            <div className="text-[10px] text-zinc-500">WINS / LOSSES</div>
                            <div
                              className={
                                "mt-1 text-sm font-semibold num " +
                                (isDark ? "text-white" : "text-slate-900")
                              }
                            >
                              {saved.wins} / {saved.losses}
                            </div>
                          </div>
                          <div
                            className={
                              "rounded border p-2 " +
                              (isDark ? "border-zinc-800" : "border-slate-200 bg-white")
                            }
                          >
                            <div className="text-[10px] text-zinc-500">WIN RATE</div>
                            <div
                              className={
                                "mt-1 text-sm font-semibold num " +
                                (isDark ? "text-white" : "text-slate-900")
                              }
                            >
                              {saved.winRate}%
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 text-[11px] text-zinc-500">
                          {saved.strategyMode === "x2x"
                            ? `X2X OP wait ${saved.x2xOpWaitTicks === null ? "No expiry" : `${saved.x2xOpWaitTicks ?? X2X_OP_WINDOW_TICKS} ticks`}`
                            : `Exact spread target ${saved.spreadThreshold}%`}
                          {" "}· Base stake{" "}
                          {saved.baseStake.toFixed(2)} USD · Martingale{" "}
                          {saved.martingaleEnabled ? "ON" : "OFF"}
                          {saved.x2xSignals?.length
                            ? ` · X2X signals ${saved.x2xSignals.length}`
                            : ""}
                        </div>

                        {expandedHistoryId === saved.id && (
                          <div className="mt-4 overflow-x-auto text-xs num">
                            <table className="w-full text-left">
                              <thead>
                                <tr
                                  className={
                                    "border-b pb-2 uppercase text-[10px] text-zinc-500 " +
                                    (isDark ? "border-zinc-800" : "border-slate-200")
                                  }
                                >
                                  <th className="py-2">Run</th>
                                  <th>Time</th>
                                  <th>Entry</th>
                                  <th>Target</th>
                                  <th>Exit</th>
                                  <th>Stake</th>
                                  <th>Status</th>
                                  <th>Contract</th>
                                  <th className="text-right">P/L</th>
                                </tr>
                              </thead>
                              <tbody
                                className={
                                  "divide-y " + (isDark ? "divide-zinc-900" : "divide-slate-100")
                                }
                              >
                                {saved.trades.map((trade) => (
                                  <tr key={trade.id}>
                                    <td className="py-2.5 font-bold">#{trade.runIndex}</td>
                                    <td className="text-zinc-500">{trade.time}</td>
                                    <td>{trade.entry}</td>
                                    <td className="font-semibold">{trade.target}</td>
                                    <td className="font-bold">{trade.result}</td>
                                    <td>{trade.stake.toFixed(2)} USD</td>
                                    <td
                                      className={
                                        trade.pnl > 0 ? "text-emerald-500" : "text-red-500"
                                      }
                                    >
                                      {trade.pnl > 0 ? "WON" : "LOST"}
                                    </td>
                                    <td className="text-zinc-500" title={trade.signalId}>
                                      {trade.contractId ?? "--"}
                                    </td>
                                    <td
                                      className={
                                        "text-right font-bold " +
                                        (trade.pnl > 0 ? "text-emerald-500" : "text-red-500")
                                      }
                                    >
                                      {trade.pnl > 0 ? "+" : ""}
                                      {trade.pnl.toFixed(2)} USD
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {expandedHistoryId === saved.id && Boolean(saved.x2xSignals?.length) && (
                          <div className="mt-4 space-y-2">
                            <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                              X2X Signal Audit
                            </h4>
                            {saved.x2xSignals?.map((signal) => (
                              <div
                                key={signal.signalId}
                                className={`grid grid-cols-[1fr_auto] gap-x-2 rounded border p-2 text-[10px] ${
                                  isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-white"
                                }`}
                              >
                                <span className="font-mono">
                                  {signal.pattern} · {signal.referencePair}{" "}
                                  →{" "}
                                  {signal.opTrigger ?? "invalid"} · LDP{" "}
                                  {signal.ldp ?? "--"}
                                </span>
                                <span className="text-right uppercase text-zinc-500">
                                  {signal.status.replaceAll("_", " ")}
                                </span>
                                <span className="text-zinc-500">
                                  {new Date(signal.detectedAt).toLocaleString()}{" "}
                                  · {formatX2XWaitProgress(signal.eligibleTicksElapsed, signal.eligibleTicksLimit)}
                                  {signal.status === "cancelled" && signal.cancelledAt
                                    ? " | cancelled ${new Date(signal.cancelledAt).toLocaleString()}"
                                    : ""}
                                  {` · ${signal.contractDuration} tick`}
                                  {signal.contractId
                                    ? ` · contract ${signal.contractId}`
                                    : ""}
                                  {signal.result
                                    ? ` · ${signal.result.toUpperCase()}`
                                    : ""}
                                </span>
                                <span className="text-zinc-500">
                                  Source:{" "}
                                  {signal.patternTickTimestamps
                                    .map(
                                      (timestamp, index) =>
                                        `${new Date(timestamp).toLocaleTimeString()} ${signal.patternQuotes[index]?.toFixed(2) ?? "--"}`,
                                    )
                                    .join(" → ")}
                                </span>
                                {signal.reason && (
                                  <span className="text-right text-zinc-500">{signal.reason}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN: Session & Bot Overview */}
          <aside
            className={`space-y-5 lg:space-y-6 ${mobileTab === "session" || mobileTab === "all" ? "block" : "hidden lg:block"}`}
          >
            {/* SESSION */}
            <section
              className={`rounded-xl border p-4 space-y-4 shadow-sm ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                SESSION
              </span>

              {/* Net P/L Hero Card */}
              <div
                className={`rounded-xl border p-4 space-y-2 ${
                  isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-zinc-500">NET P/L</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      totalPnl >= 0
                        ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                        : "bg-red-500/15 text-red-500 border border-red-500/40"
                    }`}
                  >
                    {totalPnl >= 0 ? "PROFIT" : "LOSS"}
                  </span>
                </div>
                <div
                  className={`text-3xl font-light tracking-tight num ${totalPnl > 0 ? "text-emerald-500" : totalPnl < 0 ? "text-red-500" : isDark ? "text-white" : "text-slate-900"}`}
                >
                  {totalPnl >= 0 ? "+" : ""}
                  {totalPnl.toFixed(2)}{" "}
                  <span className="text-xs font-normal text-zinc-500">USD</span>
                </div>
              </div>

              {/* 2x2 Stats Grid */}
              <div className="grid grid-cols-2 gap-3 num">
                <div
                  className={`rounded-lg border p-3 ${
                    isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="text-[10px] font-semibold text-zinc-500">WINS</span>
                  <div
                    className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {wins}
                  </div>
                </div>

                <div
                  className={`rounded-lg border p-3 ${
                    isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="text-[10px] font-semibold text-zinc-500">LOSSES</span>
                  <div className="text-2xl font-light text-zinc-400 mt-1">{losses}</div>
                </div>

                <div
                  className={`rounded-lg border p-3 ${
                    isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="text-[10px] font-semibold text-zinc-500">TRADES</span>
                  <div
                    className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {trades.length}
                  </div>
                </div>

                <div
                  className={`rounded-lg border p-3 ${
                    isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="text-[10px] font-semibold text-zinc-500">WIN RATE</span>
                  <div
                    className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {winRate}%
                  </div>
                </div>
              </div>
            </section>

            {/* BOT (Clean Strategy Telemetry - No Reps) */}
            <section
              className={`rounded-xl border p-4 space-y-3.5 shadow-sm text-xs num ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                BOT TELEMETRY
              </span>

              <div className="grid grid-cols-2 gap-y-3 gap-x-2">
                <div>
                  <div className="text-[10px] text-zinc-500">Status</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {botState}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">
                    {strategyMode === "x2x" ? "Pattern Ticks" : "1,000 Ticks"}
                  </div>
                  <div
                    className={`font-semibold ${strategyMode === "x2x" || digits.length >= WINDOW ? "text-zinc-400" : "text-amber-500"}`}
                  >
                    {strategyMode === "x2x"
                      ? `${x2xScannerState.recentDigits.length}/3 live`
                      : digits.length >= WINDOW
                        ? "VERIFIED"
                        : `${digits.length}/${WINDOW}`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Pending</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {pending.current ? "yes" : "no"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Mode</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {strategyMode === "x2x" ? "X2X Sniper" : "Matches"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Session Trades</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {runCount}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">
                    {strategyMode === "x2x" ? "Live Digits" : "Entry Digit"}
                  </div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {strategyMode === "x2x"
                      ? x2xScannerState.recentDigits.join(" / ") || "--"
                      : `${analysis.most} (${analysis.mostPct.toFixed(1)}%)`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">
                    {strategyMode === "x2x" ? "Stored LDP" : "Match Target"}
                  </div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {strategyMode === "x2x"
                      ? ((x2xScannerState.signal?.phase === "awaiting-op"
                          ? x2xScannerState.signal.ldp
                          : pending.current?.target) ?? "--")
                      : `${analysis.second} (${analysis.secondPct.toFixed(1)}%)`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">
                    {strategyMode === "x2x" ? "OP Trigger" : "Spread Target"}
                  </div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {strategyMode === "x2x"
                      ? (x2xScannerState.signal?.opTrigger ?? "--")
                      : `Δ = ${maxDiff}%`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Symbol</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {currentMarket.classicSymbol}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Duration</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
                    1 tick
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Feed Status</div>
                  <div className="font-semibold text-zinc-600 uppercase">{status}</div>
                </div>
              </div>

              {/* Bot Status Note */}
              <div
                className={`rounded-lg border p-2.5 mt-2 text-[11px] leading-relaxed ${
                  isDark
                    ? "border-zinc-900 bg-black text-zinc-400"
                    : "border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                {note}
              </div>
            </section>
          </aside>
        </div>
        {/* Footer */}
        <footer
          className={`mt-10 pt-6 border-t text-center font-mono text-xs transition-colors ${
            isDark ? "border-zinc-900 text-zinc-500" : "border-slate-200 text-slate-500"
          }`}
        >
          <div className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5">
            <span>Built by</span>
            <a
              href="https://architeq.co.za"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-zinc-400 hover:text-zinc-300 hover:underline transition-colors"
            >
              Architeq Web Agency ©
            </a>
          </div>
        </footer>
      </main>

      {/* 3. Mobile Sticky Bottom Action Bar (Thumb-Friendly Single Row with Safe Area Protection) */}
      <div
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0.75rem)" }}
        className={`lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t backdrop-blur-md transition-colors ${
          isDark
            ? "border-zinc-900 bg-black/95 text-white shadow-2xl"
            : "border-slate-200 bg-white/95 text-slate-900 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]"
        }`}
      >
        <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={() => stopBot("User stopped bot.")}
              className="flex-1 h-12 rounded-xl bg-rose-600 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
              STOP BOT
            </button>
          ) : (
            <button
              type="button"
              onClick={startBot}
              disabled={digits.length < startTickRequirement}
              className={`flex-1 h-12 rounded-xl px-4 text-xs font-bold uppercase tracking-wider shadow-md active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                isDark
                  ? "bg-white text-black hover:bg-zinc-200"
                  : "bg-slate-900 text-white hover:bg-slate-800"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${digits.length >= startTickRequirement ? (isDark ? "bg-black" : "bg-emerald-400") : "bg-amber-300"}`}
              />
              {digits.length < startTickRequirement
                ? `BUFFERING (${digits.length}/${startTickRequirement})`
                : "START BOT"}
            </button>
          )}

          <button
            type="button"
            onClick={resetSession}
            title="Reset session"
            className={`h-12 px-4 rounded-xl border text-xs font-bold uppercase tracking-wider transition-colors ${
              isDark
                ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                : "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            RESET
          </button>

          <button
            type="button"
            onClick={triggerManualTestTrade}
            disabled={strategyMode === "x2x" || digits.length < WINDOW || pending.current !== null}
            title="Run 1 test trade"
            className={`h-12 px-4 rounded-xl border text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 ${
              isDark
                ? "border-zinc-700 bg-zinc-900 text-zinc-300"
                : "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            TEST 1
          </button>
        </div>
      </div>

      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-md border p-5 sm:p-6 space-y-5 shadow-2xl ${
              isDark
                ? "border-zinc-800 bg-zinc-950 text-white"
                : "border-slate-300 bg-white text-slate-900"
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-3 ${
                isDark ? "border-zinc-900" : "border-slate-200"
              }`}
            >
              <div className="space-y-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Deriv
                </span>
                <h3 className="font-display text-sm font-semibold uppercase tracking-wider">
                  Connect account
                </h3>
              </div>
              <button
                onClick={() => {
                  setShowConnectModal(false);
                }}
                className="text-xs font-semibold uppercase text-zinc-500 hover:text-white"
              >
                [X]
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Deriv Auth 2.0
                </span>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Authenticate securely via Deriv Auth 2.0 PKCE. All trading permissions and
                  demo/real accounts will be loaded automatically.
                </p>
              </div>

              <button
                type="button"
                onClick={handleDirectOAuth}
                className="w-full bg-white py-3 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
              >
                Sign in with Deriv Auth 2.0
              </button>

              <p className="text-[10px] text-zinc-500 text-center leading-tight">
                Redirects to Deriv login. Demo and real accounts will be synchronized immediately
                upon return.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 5. Mobile Menu & Settings Drawer (< lg screens) */}
      {showMobileMenu && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-sm lg:hidden">
          <div
            style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 1.25rem)" }}
            className={`w-full max-w-lg rounded-t-2xl border-t p-5 pt-4 space-y-4 shadow-2xl animate-in slide-in-from-bottom duration-200 max-h-[90vh] overflow-y-auto ${
              isDark
                ? "border-zinc-800 bg-zinc-950 text-white"
                : "border-slate-300 bg-white text-slate-900"
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-3 ${
                isDark ? "border-zinc-900" : "border-slate-200"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-zinc-300" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  Terminal Settings
                </span>
              </div>
              <button
                onClick={() => setShowMobileMenu(false)}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [CLOSE]
              </button>
            </div>

            {/* Market Index Selection */}
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">Market Index</label>
              <div
                className={`grid grid-cols-2 gap-1 rounded border p-0.5 ${
                  isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-100"
                }`}
              >
                {MARKET_LIST.map((m) => {
                  const isSelected = marketSymbol === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={running}
                      onClick={() => handleSelectMarket(m.id)}
                      className={`rounded py-2 px-2 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                        isSelected
                          ? isDark
                            ? "bg-zinc-800 text-white shadow-sm"
                            : "bg-white text-slate-900 shadow-sm"
                          : "text-zinc-500 hover:text-white disabled:opacity-40"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isSelected ? "bg-emerald-400" : "bg-zinc-600"
                        }`}
                      />
                      <span>{m.displayName}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Switch Account */}
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">Switch Account</label>
              <select
                value={activeId || ""}
                onChange={(e) => switchAccount(e.target.value)}
                className={`w-full rounded border p-2.5 text-xs font-semibold outline-none ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900 text-white"
                    : "border-slate-300 bg-white text-slate-900"
                }`}
              >
                {accounts.map((acc) => (
                  <option key={acc.account_id} value={acc.account_id}>
                    {acc.account_id} ({acc.account_type === "real" ? "Real" : "Demo"})
                    — $
                    {Number(acc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </option>
                ))}
              </select>
            </div>

            {/* Quick Actions Grid */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={toggleNotifications}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 ${
                  notifsEnabled
                    ? isDark
                      ? "border-zinc-600 bg-zinc-900 text-zinc-300"
                      : "border-zinc-500 bg-zinc-100 text-zinc-800"
                    : isDark
                      ? "border-zinc-800 bg-zinc-900 text-zinc-400"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    notifsEnabled
                      ? isDark
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-emerald-600 animate-pulse"
                      : isDark
                        ? "bg-zinc-600"
                        : "bg-slate-400"
                  }`}
                />
                NOTIF: {notifsEnabled ? "ON" : "OFF"}
              </button>

              <button
                type="button"
                onClick={toggleSound}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 ${
                  soundEnabled
                    ? isDark
                      ? "border-zinc-700 bg-zinc-900 text-zinc-200"
                      : "border-slate-300 bg-slate-100 text-slate-800"
                    : isDark
                      ? "border-zinc-800 text-zinc-500"
                      : "border-slate-200 text-slate-400"
                }`}
              >
                SOUND: {soundEnabled ? "ON" : "OFF"}
              </button>

              <button
                type="button"
                onClick={toggleTheme}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900 text-zinc-200"
                    : "border-slate-300 bg-slate-100 text-slate-800"
                }`}
              >
                THEME: {isDark ? "DARK" : "LIGHT"}
              </button>

              <button
                type="button"
                onClick={runBacktest1000Ticks}
                disabled={digits.length < WINDOW}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900 text-zinc-200"
                    : "border-slate-300 bg-slate-100 text-slate-800"
                }`}
              >
                TEST 1K TICKS
              </button>
            </div>

            {/* Install PWA Button (if available) */}
            {!isStandalone && (installable || isIOS()) && (
              <button
                type="button"
                onClick={() => {
                  setShowMobileMenu(false);
                  handleInstallApp();
                }}
                className="w-full rounded bg-white py-3 text-xs font-bold uppercase tracking-wider text-black shadow-sm"
              >
                INSTALL APP ON HOME SCREEN
              </button>
            )}

            {/* Connect Account Button */}
            <button
              type="button"
              onClick={() => {
                setShowMobileMenu(false);
                setShowConnectModal(true);
              }}
              className={`w-full rounded border py-2.5 text-xs font-bold uppercase tracking-wider ${
                isDark
                  ? "border-zinc-700 text-zinc-300 bg-zinc-900/40"
                  : "border-zinc-300 text-zinc-800 bg-zinc-100"
              }`}
            >
              CONNECT DERIV ACCOUNT
            </button>

            {/* Exit Button */}
            <button
              type="button"
              onClick={() => {
                session.clear();
                clearAllDerivAuth();
                navigate({ to: "/" });
              }}
              className="w-full rounded border border-zinc-800 text-zinc-400 py-2.5 text-xs font-bold uppercase tracking-wider hover:text-white"
            >
              LOG OUT & EXIT
            </button>

            {/* Mobile Drawer Attribution */}
            <div
              className={`pt-2 border-t text-center font-mono text-[11px] ${
                isDark ? "border-zinc-900 text-zinc-500" : "border-slate-200 text-slate-500"
              }`}
            >
              <span>Built by </span>
              <a
                href="https://architeq.co.za"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-zinc-300 font-bold hover:underline"
              >
                Architeq Web Agency ©
              </a>
            </div>
          </div>
        </div>
      )}

      {/* 6. Backtest / Test Results Modal */}
      {showBacktestModal && backtest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-lg rounded-xl border p-5 sm:p-6 space-y-5 shadow-2xl ${
              isDark
                ? "border-zinc-800 bg-zinc-950 text-white"
                : "border-slate-200 bg-white text-slate-900"
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-3 ${
                isDark ? "border-zinc-900" : "border-slate-200"
              }`}
            >
              <span
                className={`text-xs font-bold uppercase tracking-wider ${isDark ? "text-white" : "text-slate-900"}`}
              >
                {backtest.strategyMode === "x2x"
                  ? "X2X SNIPER / 1,000 TICK REPLAY"
                  : "MATCHES / 1,000 TICK BACKTEST"}
              </span>
              <button
                onClick={() => setShowBacktestModal(false)}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [X]
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              {backtest.strategyMode === "x2x"
                ? `Replayed the same X2X scanner over ${backtest.totalTicks} recent ${currentMarket.displayName} quotes. Each trigger simulates a one-tick Digit Match using its stored LDP. This tick-only replay has no historical payout quotes, so it does not estimate profitability.`
                : `Calculated across the latest ${backtest.totalTicks} real market ticks of ${currentMarket.displayName} using the Deriv Matches strategy (spread must equal ${maxDiff}%, enter on most appearing digit, target second most appearing digit). If the observed spread does not equal the target, no entries are counted.`}
            </p>

            {backtest.x2x ? (
              <div
                className={`grid grid-cols-2 sm:grid-cols-3 gap-4 rounded border p-4 num ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}
              >
                {[
                  ["Patterns detected", backtest.x2x.patternsDetected],
                  ["Valid signals", backtest.x2x.validSignals],
                  ["OP triggers", backtest.x2x.triggers],
                  ["Simulated trades", backtest.x2x.executedTrades],
                  ["Wins / losses", `${backtest.x2x.wins} / ${backtest.x2x.losses}`],
                  ["Settled win rate", `${backtest.x2x.winRate.toFixed(1)}%`],
                  ["Expired", backtest.x2x.expiredSignals],
                  ["Rejected", backtest.x2x.rejectedSignals],
                  ["Unsettled at end", backtest.x2x.unsettledTrades],
                  ["Payout adjusted P/L", "Unavailable"],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <span className="text-[10px] uppercase text-zinc-500">{label}</span>
                    <div
                      className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className={`grid grid-cols-2 gap-4 rounded border p-4 num ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}
              >
                <div>
                  <span className="text-[10px] uppercase text-zinc-500">Signals Found</span>
                  <div
                    className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {backtest.signals}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] uppercase text-zinc-500">Win Rate</span>
                  <div
                    className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {backtest.winRate.toFixed(1)}%
                  </div>
                </div>
                <div>
                  <span className="text-[10px] uppercase text-zinc-500">Wins / Losses</span>
                  <div
                    className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {backtest.wins}W · {backtest.losses}L
                  </div>
                </div>
                <div>
                  <span className="text-[10px] uppercase text-zinc-500">Simulated Net P/L</span>
                  <div
                    className={`text-2xl font-light ${backtest.netPnl !== null && backtest.netPnl > 0 ? "text-emerald-500" : backtest.netPnl !== null && backtest.netPnl < 0 ? "text-red-500" : isDark ? "text-white" : "text-slate-900"}`}
                  >
                    {backtest.netPnl === null
                      ? "Unavailable"
                      : `${backtest.netPnl >= 0 ? "+" : ""}$${backtest.netPnl.toFixed(2)}`}
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={() => setShowBacktestModal(false)}
              className="w-full rounded border border-white bg-white py-2.5 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
            >
              CLOSE TEST RESULTS
            </button>
          </div>
        </div>
      )}

      {/* 7. iOS PWA Install Guide Modal */}
      {showIOSInstallGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-sm rounded-xl border p-5 sm:p-6 space-y-4 shadow-2xl ${
              isDark
                ? "border-zinc-800 bg-zinc-950 text-white"
                : "border-slate-300 bg-white text-slate-900"
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-3 ${
                isDark ? "border-zinc-900" : "border-slate-200"
              }`}
            >
              <span className="text-xs font-bold uppercase tracking-wider">Install on iOS</span>
              <button
                onClick={() => setShowIOSInstallGuide(false)}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [X]
              </button>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              To install ThDpst Matches as a full-screen app on your iPhone or iPad home screen:
            </p>
            <ol className="space-y-2.5 text-xs text-zinc-300 list-decimal list-inside leading-relaxed">
              <li>
                Tap the <span className="font-semibold text-zinc-300">Share</span> button in
                Safari's bottom toolbar.
              </li>
              <li>
                Scroll down and select{" "}
                <span className="font-semibold text-zinc-300">Add to Home Screen</span>.
              </li>
              <li>
                Tap <span className="font-semibold text-zinc-300">Add</span> in the top-right
                corner.
              </li>
            </ol>
            <button
              onClick={() => setShowIOSInstallGuide(false)}
              className="w-full rounded bg-white py-2.5 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TradeTerminal;
