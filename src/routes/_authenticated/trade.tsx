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
import { DerivTradingSession, type ContractResult } from "@/lib/deriv-trading";
import {
  analyze,
  lastDigit,
  shouldEnter,
  MAX_DIFF,
  MAX_RUNS,
  SYMBOL,
  CLASSIC_SYMBOL,
  OPTIONS_SYMBOL,
  WINDOW,
} from "@/lib/matches";
import {
  isNotificationSupported,
  isNotificationEnabled,
  setNotificationEnabled,
  requestNotificationPermission,
  notifyTradeWon,
  notifyTradeLost,
  notifyTakeProfit,
  notifyStopLoss,
  notifyCycleCompleted,
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
import {
  isRunningStandalone,
  isIOS,
  onInstallableChange,
  triggerInstallPrompt,
} from "@/lib/pwa";
import { calculateMatchesPayout, DERIV_MATCH_BASE_PAYOUT_RATIO } from "@/lib/payout";

export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({
    meta: [
      { title: "ThDpst Matches // Volatility 100" },
      { name: "description", content: "Deriv Matches smart trader bot for Volatility 100." },
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
}

interface PendingTrade {
  runIndex: number;
  entry: number;
  target: number;
  stake: number;
  /** When true, settlement comes from Deriv contract result — not the next local tick. */
  live?: boolean;
}

interface TickItem {
  time: string;
  price: number;
  digit: number;
}

interface BacktestSummary {
  totalTicks: number;
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
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
  const [inAppAlert, setInAppAlert] = useState<{ id: number; title: string; body: string; type: string } | null>(null);

  // Mobile settings drawer/modal
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // App ID and configured markup dynamically resolved for this application
  const activeAppId = getDerivClientId();
  const [configuredMarkup, setConfiguredMarkup] = useState<number>(() => getAppIdMarkup(activeAppId));

  // Derive activeAccount and activeType (case-insensitive — Deriv loginids vary in casing)
  const activeAccount =
    accounts.find((a) => a.account_id.toUpperCase() === String(activeId || "").toUpperCase()) ||
    accounts[0];
  const activeType: "demo" | "real" = activeAccount?.account_type || "demo";

  // Market stream state: strictly chronological ticks and digits
  const [digits, setDigits] = useState<number[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [recentTicks, setRecentTicks] = useState<TickItem[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  // Strategy & Bot configuration (Strictly Matches strategy parameters)
  const [maxDiff, setMaxDiff] = useState<number>(0.3); // 0.3% is the user's strict requirement, configurable for testing
  const [maxDiffInput, setMaxDiffInput] = useState<string>("0.3");
  const [reAnalyzeOnLoss, setReAnalyzeOnLoss] = useState(true);
  const [cycleRuns, setCycleRuns] = useState<number>(MAX_RUNS); // trades per cycle (user configurable)
  const [stopOnWin, setStopOnWin] = useState(false); // stop the bot after its first win
  const [stake, setStake] = useState<number>(1);
  const [stakeInput, setStakeInput] = useState<string>("1");
  const [riskTab, setRiskTab] = useState<"pnl" | "count">("pnl");
  const [tp, setTp] = useState<number>(15);
  const [tpInput, setTpInput] = useState<string>("15");
  const [sl, setSl] = useState<number>(5);
  const [slInput, setSlInput] = useState<string>("5");
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

  // Execution state
  const [running, setRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [botState, setBotState] = useState<"IDLE" | "BUFFERING" | "ANALYZING" | "WAITING ENTRY" | "IN TRADE" | "LOSS RE-ANALYSIS" | "COMPLETED" | "CYCLING">("BUFFERING");
  const [cycleCount, setCycleCount] = useState(0);
  const [note, setNote] = useState("Buffering last 1,000 market ticks before analyzing Volatility 100...");

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
            : "Alerts sync on open devices. " + (push.error || "Background push will turn on once keys/tables are configured."),
          skipSync: true,
        });
      } else if (perm === "denied") {
        alert("Notifications are blocked in your browser or device settings. Please allow notifications for this site to receive trade alerts.");
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
  const pendingSetAt = useRef<number>(0); // timestamp when pending was set, for stuck-trade safety
  const digitsRef = useRef<number[]>([]); // synchronous market digits buffer, avoids state batching drops
  const lossCooldownTicks = useRef(0);
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
    activeId,
    maxDiff,
    configuredMarkup,
    cycleCount,
    cycleRuns,
    stopOnWin,
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
    activeId,
    maxDiff,
    configuredMarkup,
    cycleCount,
    cycleRuns,
    stopOnWin,
  };

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

  const applyBalanceToAccounts = useCallback((loginid: string, balance: number, currency?: string) => {
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
  }, []);

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
            (a) => a.account_id.toUpperCase() === String(storedActive || "").toUpperCase()
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
      (a) => a.account_id !== "VRTC1029384" && a.account_id !== "CR91945350"
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
    const wsUrl = getDerivWsUrl(activeAppId);
    const ws = new DerivWS(wsUrl, (s) => setStatus(s));
    wsRef.current = ws;

    // Listen for live proposal responses from Deriv to sync exact App ID server markup
    ws.registerHandler("proposal", (data) => {
      const pData = data['proposal'] as { payout?: number; ask_price?: number };
      if (pData?.payout && pData?.ask_price) {
        const ask = pData.ask_price;
        const payout = pData.payout;
        const baseGross = ask * DERIV_MATCH_BASE_PAYOUT_RATIO;
        if (baseGross > 0) {
          const liveMarkup = Math.max(0, Math.round(((baseGross - payout) / baseGross) * 1000) / 10);
          if (liveMarkup >= 0 && liveMarkup <= 10) {
            setConfiguredMarkup(liveMarkup);
            setAppIdMarkup(activeAppId, liveMarkup);
          }
        }
      }
    });

    // Listen for tick history and incoming live ticks
    ws.registerHandler("history", (data) => {
      const history = data['history'] as { prices?: number[]; times?: number[] };
      if (history?.prices && history.prices.length > 0) {
        const pList = history.prices;
        const tList = history.times || [];
        const dList = pList.map((p) => lastDigit(p));
        digitsRef.current = dList;
        setDigits(dList);
        setPrice(pList[pList.length - 1] ?? null);

        // Prepopulate tick stream strictly in chronological order (newest first for table)
        const initialTicks: TickItem[] = [];
        const count = Math.min(15, pList.length);
        for (let i = pList.length - count; i < pList.length; i++) {
          const ts = tList[i];
          const timestamp = ts ? new Date(ts * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          initialTicks.unshift({
            time: timestamp,
            price: pList[i] ?? 0,
            digit: dList[i] ?? 0,
          });
        }
        setRecentTicks(initialTicks);

        const a = analyze(dList);
        setBotState("IDLE");
        setNote(
          `1,000 ticks analyzed on Volatility 100: Entry [${a.most}] (${a.mostPct.toFixed(1)}%), Match Target [${a.second}] (${a.secondPct.toFixed(1)}%), Spread: ${a.diff.toFixed(2)}% (Threshold: <= ${MAX_DIFF}%). Ready to run.`
        );
      }
    });

    ws.registerHandler("tick", (data) => {
      const tick = data['tick'] as { quote?: number; epoch?: number };
      if (typeof tick?.quote === "number") {
        const q = tick.quote;
        const timeStr = tick.epoch ? new Date(tick.epoch * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
        const nextDigit = lastDigit(q);

        setPrice(q);

        // Tick stream: prepend latest incoming tick to top
        setRecentTicks((prev) => [{ time: timeStr, price: q, digit: nextDigit }, ...prev.slice(0, 14)]);

        // Digits stream: append synchronously into ref to avoid state-updater batching issues
        digitsRef.current.push(nextDigit);
        if (digitsRef.current.length > WINDOW) {
          digitsRef.current.shift();
        }
        const updatedDigits = [...digitsRef.current];
        setDigits(updatedDigits);

        // Process trade event immediately with guaranteed current digits
        handleTickEventRef.current(updatedDigits, q, nextDigit);
      }
    });

    // Request 1000 ticks: Volatility 100 uses R_100 (classic/options feed)
    const subscribeTicks = async () => {
      const payload = (sym: string) => ({
        ticks_history: sym,
        count: WINDOW,
        end: "latest",
        style: "ticks",
        subscribe: 1,
      });
      try {
        await ws.send(payload(CLASSIC_SYMBOL));
      } catch {
        try {
          await ws.send(payload(OPTIONS_SYMBOL));
        } catch (err) {
          console.error("Ticks subscription error:", err);
          // Last resort: classic Binary public socket
          try {
            ws.updateUrl(`wss://ws.derivws.com/websockets/v3?app_id=1089`);
            await ws.waitForOpen(8000);
            await ws.send(payload(CLASSIC_SYMBOL));
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
  }, []);

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
    balanceAfter?: number
  ) {
    const s = stateRef.current;

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
    };

    const updatedTrades = [newRow, ...s.trades];
    setTrades(updatedTrades);

    if (updateLocalBalance) {
      // Paper mode only — live balances come from Deriv buy/balance sockets
      setAccounts((prev) => {
        const targetId = (s.activeId || activeId || (prev[0] ? prev[0].account_id : "")).toUpperCase();
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

    if (totalPnl >= s.tp) {
      notifyTakeProfit(totalPnl);
      return stopBot(`Take Profit reached (+$${totalPnl.toFixed(2)})`);
    }
    if (totalPnl <= -s.sl) {
      notifyStopLoss(totalPnl);
      return stopBot(`Stop Loss reached (-$${Math.abs(totalPnl).toFixed(2)})`);
    }
    if (won && s.stopOnWin) {
      return stopBot(`First win landed (+$${totalPnl.toFixed(2)}) — bot stopped after 1 win.`);
    }
    if (nextRunCount >= s.cycleRuns) {
      notifyCycleCompleted(s.cycleRuns, totalPnl);
      // Auto-cycle: reset run count for the next cycle instead of stopping
      const nextCycle = (stateRef.current.cycleCount || 0) + 1;
      setCycleCount(nextCycle);
      setRunCount(0);
      lossCooldownTicks.current = 0;
      setBotState("ANALYZING");
      setNote(
        `Cycle ${nextCycle} completed (${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}). Auto-starting cycle ${nextCycle + 1} — analyzing market...`
      );
      return;
    }

    if (!won && s.reAnalyzeOnLoss) {
      lossCooldownTicks.current = 5;
      setBotState("LOSS RE-ANALYSIS");
      setNote(
        `Run ${p.runIndex}/${s.cycleRuns} Lost (${resultDigit} ≠ ${p.target}). Re-analyzing market distribution...`
      );
      return;
    }

    setBotState("ANALYZING");
    setNote(
      `Run ${p.runIndex}/${s.cycleRuns} ${won ? "Won" : "Lost"} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD). Analyzing market for run ${nextRunCount + 1}...`
    );
  }

  function placeLiveMatch(p: PendingTrade) {
    const session = tradingRef.current;
    const currency = activeAccount?.currency || "USD";
    if (!session?.isReady()) {
      pending.current = null;
      setBotState("ANALYZING");
      setNote("Trading session connecting. Will retry on next signal...");
      return;
    }

    session
      .buyDigitMatch({
        stake: p.stake,
        barrierDigit: p.target,
        currency,
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
          result.balanceAfter
        );
      })
      .catch((err: Error) => {
        pending.current = null;
        lossCooldownTicks.current = 3;
        setBotState("ANALYZING");
        setNote(`Trade notice: ${err.message}. Retrying on next signal...`);
        setTradingStatusNote(err.message);
        if (stateRef.current.running) notifyTradeFailed(err.message);
      });
  }

  function handleTickEvent(tickList: number[], _currentPrice: number, currentD: number) {
    const s = stateRef.current;

    // Live contracts settle via Deriv proposal_open_contract — ignore local tick settlement
    if (pending.current?.live) {
      // Safety net: if pending has been stuck for >60 seconds, force-clear it
      const elapsed = Date.now() - pendingSetAt.current;
      if (elapsed > 60_000) {
        console.warn('[bot] Force-clearing stuck pending trade after', Math.round(elapsed / 1000), 'seconds');
        pending.current = null;
        pendingSetAt.current = 0;
        setBotState("ANALYZING");
        setNote("Trade settlement timed out. Resuming analysis...");
        // Fall through to continue processing
      } else {
        return;
      }
    }

    // Clear any stale non-live pending trade and continue scanning
    if (pending.current && !pending.current.live) {
      pending.current = null;
    }

    if (!s.running) return;

    if (tickList.length < WINDOW) {
      setBotState("BUFFERING");
      setNote(
        `Buffering market ticks (${tickList.length}/${WINDOW}). Analyzing last 1,000 ticks before evaluating entry...`
      );
      return;
    }

    if (s.botState === "LOSS RE-ANALYSIS") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setNote(`Loss re-analysis: streaming fresh ticks (${lossCooldownTicks.current} remaining)...`);
        return;
      }
      setBotState("ANALYZING");
    }

    const a = analyze(tickList, s.maxDiff);

    if (shouldEnter(a, currentD)) {
      const targetRun = s.runCount + 1;
      const useLive = Boolean(tradingRef.current?.isReady());
      if (!useLive) {
        setBotState("ANALYZING");
        setNote(
          "Waiting for Deriv trading connection before entering trade..."
        );
        return;
      }
      pending.current = {
        runIndex: targetRun,
        entry: currentD,
        target: a.second,
        stake: s.stake,
        live: true,
      };
      pendingSetAt.current = Date.now();
      setBotState("IN TRADE");
      setNote(
        `Run ${targetRun}/${s.cycleRuns}: Buying DIGITMATCH on Deriv — entry ${currentD}, match ${a.second}...`
      );
      placeLiveMatch(pending.current);
    } else if (a.ok) {
      setBotState("WAITING ENTRY");
      setNote(
        `Spread verified (Δ ${a.diff.toFixed(2)}% ≤ ${s.maxDiff}%). Waiting for entry digit ${a.most}...`
      );
    } else {
      setBotState("ANALYZING");
      setNote(`Spread Δ ${a.diff.toFixed(2)}% > ${s.maxDiff}%. Analyzing last 1,000 ticks...`);
    }
  }

  function startBot() {
    initAudioContext();
    if (digits.length < WINDOW) {
      setNote(
        `Cannot start bot: Buffering market ticks (${digits.length}/${WINDOW}). Exactly 1,000 ticks must be analyzed before entering a trade.`
      );
      return;
    }
    if (!isConnectedToDeriv || !tradingReady) {
      setShowConnectModal(true);
      setNote(
        "Connect Deriv Auth 2.0 so trades hit your account and the balance updates."
      );
      return;
    }
    if (!activeAccount) {
      setShowConnectModal(true);
      setNote("No Deriv account selected. Connect Deriv first.");
      return;
    }
    setTrades([]);
    setRunCount(0);
    pending.current = null;
    lossCooldownTicks.current = 0;
    connectionLostAlertedRef.current = false;
    setRunning(true);
    stateRef.current.running = true;
    setBotState("ANALYZING");
    setNote(
      `Bot active on ${activeAccount.account_id}. Live DIGITMATCH buys on Volatility 100 — Run 1...`
    );
    notifyBotStarted(activeAccount.account_id, getDeviceLabel());
  }

  function stopBot(message: string) {
    const wasRunning = running || stateRef.current.running;
    setRunning(false);
    stateRef.current.running = false;
    connectionLostAlertedRef.current = false;
    setBotState("IDLE");
    setNote(message);
    pending.current = null;
    if (wasRunning) {
      notifyBotStopped(message);
    }
  }

  function resetSession() {
    stopBot("Session reset.");
    setTrades([]);
    setRunCount(0);
  }

  // Pull the latest balance from Deriv (demo top-ups happen in Deriv, not locally)
  function resetDemoBalance() {
    refreshDerivBalances();
    setNote("Synced balance from Deriv. Top up demo funds in your Deriv account if needed.");
  }

  function runBacktest1000Ticks() {
    if (digits.length < WINDOW) {
      alert(`Buffering market ticks. Exactly 1,000 ticks are required to calculate the test (${digits.length}/${WINDOW} collected so far).`);
      return;
    }

    const windowDigits = digits.slice(-WINDOW);
    const a = analyze(windowDigits);
    let signals = 0;
    let wins = 0;
    let losses = 0;
    let pnl = 0;

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

    const winRate = signals > 0 ? (wins / signals) * 100 : 0;
    setBacktest({
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
        `No ${targetType} account on this Deriv login. Open Deriv and create one, then reconnect.`
      );
      setShowConnectModal(true);
    }
  }

  function triggerManualTestTrade() {
    initAudioContext();
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
    const targetRun = (runCount % cycleRuns) + 1;
    const p: PendingTrade = {
      runIndex: targetRun,
      entry: a.most,
      target: a.second,
      stake,
      live: true,
    };
    pending.current = p;
    pendingSetAt.current = Date.now();
    setBotState("IN TRADE");
    setNote(
      `Test run ${targetRun}/${cycleRuns}: Buying DIGITMATCH — match digit ${a.second} on Deriv...`
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

  // Strictly chronological sequence of the latest 33 digits (incoming order from left to right)
  const recentDigits33 = digits.slice(-33);

  return (
    <div className={`min-h-screen font-sans antialiased transition-colors overflow-x-hidden ${
      isDark ? "bg-black text-white" : "bg-[#f4f6f8] text-slate-800"
    }`}>
      {/* Floating In-App Alert Toast (Cross-device feedback) */}
      {inAppAlert && (
        <aside
          role="status"
          aria-live="polite"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-md animate-in fade-in slide-in-from-top-4 duration-200 lg:top-auto lg:bottom-6 lg:left-auto lg:right-6 lg:translate-x-0 lg:w-80 lg:slide-in-from-right-4"
        >
          <div className={`rounded-lg border px-4 py-3 shadow-2xl flex items-start justify-between gap-3 ${
            inAppAlert.type === "win"
              ? isDark ? "border-emerald-500/60 bg-zinc-950 text-emerald-400" : "border-emerald-500 bg-emerald-50 text-emerald-700"
              : inAppAlert.type === "loss"
              ? isDark ? "border-red-500/60 bg-zinc-950 text-red-400" : "border-red-500 bg-red-50 text-red-700"
              : isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-300 bg-white text-slate-900"
          }`}>
            <div className="space-y-0.5">
              <div className="text-xs font-bold uppercase tracking-wider">{inAppAlert.title}</div>
              <div className="text-[11px] opacity-80 leading-snug">{inAppAlert.body}</div>
            </div>
            <button
              onClick={() => setInAppAlert(null)}
              className="text-xs font-bold opacity-60 hover:opacity-100 p-1"
            >
              [X]
            </button>
          </div>
        </aside>
      )}

      {/* 1. Header Bar: Responsive for Mobile, Tablet & Desktop */}
      <header className={`border-b safe-top px-3 sm:px-6 py-2.5 sm:py-3 transition-colors sticky top-0 z-30 ${
        isDark ? "border-zinc-900 bg-zinc-950/95 backdrop-blur-md" : "border-slate-200 bg-white/95 backdrop-blur-md"
      }`}>
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-2 sm:gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <img src="/app-icon.png" alt="ThDpst Matches" className="h-5 w-5 rounded object-cover" />
            <span className={`text-xs sm:text-sm font-bold tracking-wider uppercase ${isDark ? "text-white" : "text-slate-900"}`}>
              ThDpst Matches <span className="hidden md:inline font-normal text-zinc-500">// Volatility 100</span>
            </span>
          </div>

          {/* Desktop Bot Telemetry Pill (lg screens only) */}
          <div className={`hidden xl:flex min-w-0 items-center gap-2 border-l pl-3 text-xs ${
            isDark ? "border-zinc-800" : "border-slate-200"
          }`}>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-zinc-300 animate-pulse" : "bg-zinc-600"}`} />
              <span className="font-semibold text-zinc-400 uppercase text-[11px]">{botState}</span>
            </div>
            <span className={isDark ? "text-zinc-800" : "text-slate-300"}>|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px]">P/L</span>
              <span className={`font-semibold num ${
                totalPnl > 0
                  ? "text-emerald-500 font-bold"
                  : totalPnl < 0 ? "text-red-500 font-bold" : isDark ? "text-white" : "text-slate-700"
              }`}>
                {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
              </span>
            </div>
            <span className={isDark ? "text-zinc-800" : "text-slate-300"}>|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px]">TRADES</span>
              <span className={`font-semibold num ${isDark ? "text-zinc-200" : "text-slate-700"}`}>{trades.length}</span>
            </div>
          </div>

          {/* Desktop Right Header Controls (lg screens) */}
          <div className="hidden lg:flex min-w-0 flex-wrap items-center justify-end gap-2.5">
            {/* Live Balance */}
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
              <span className="text-zinc-500">{activeAccount?.currency || "USD"}</span>
              <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                {activeAccount?.balance ? Number(activeAccount.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "0.00"}
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
                <option key={acc.account_id} value={acc.account_id} className={isDark ? "bg-zinc-900 text-white" : "bg-white text-slate-900"}>
                  {acc.account_id} ({acc.account_type === "real" ? "Real" : "Demo"}) — ${Number(acc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </option>
              ))}
            </select>

            {/* Notification Toggle */}
            <button
              type="button"
              onClick={toggleNotifications}
              title={notifsEnabled ? "Alerts on — synced across your devices" : "Enable alerts on this device (syncs across devices)"}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                notifsEnabled
                  ? isDark ? "border-zinc-600 bg-zinc-900 text-zinc-300 font-bold" : "border-zinc-500 bg-zinc-100 text-zinc-800 font-bold"
                  : isDark ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-white" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${notifsEnabled ? "bg-zinc-300 animate-pulse" : "bg-zinc-600"}`} />
              <span>NOTIF: {notifsEnabled ? "ON" : "OFF"}</span>
            </button>

            {/* Audio Alert Toggle */}
            <button
              type="button"
              onClick={toggleSound}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                soundEnabled
                  ? isDark ? "border-zinc-700 bg-zinc-900 text-zinc-200" : "border-slate-300 bg-slate-100 text-slate-800"
                  : isDark ? "border-zinc-800 text-zinc-500" : "border-slate-200 text-slate-400"
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
                isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white" : "border-slate-300 bg-white text-slate-700 hover:text-slate-900"
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
                isDark ? "border-zinc-800 text-zinc-400 hover:text-white" : "border-slate-300 text-slate-600 hover:text-slate-900"
              }`}
            >
              EXIT
            </button>

            {/* Desktop Action Buttons */}
            <div className={`flex items-center gap-1.5 pl-2 border-l ${isDark ? "border-zinc-800" : "border-slate-200"}`}>
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
                  disabled={digits.length < WINDOW}
                  className="rounded bg-white px-4 py-2 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {digits.length < WINDOW ? `BUFFERING (${digits.length}/${WINDOW})` : "START BOT"}
                </button>
              )}

              <button
                onClick={resetSession}
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white" : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                RESET
              </button>

              <button
                onClick={triggerManualTestTrade}
                disabled={digits.length < WINDOW || pending.current !== null}
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 ${
                  isDark ? "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600" : "border-zinc-300 bg-zinc-100 text-zinc-800"
                }`}
              >
                TEST 1
              </button>

              <button
                onClick={runBacktest1000Ticks}
                className={`rounded border px-2.5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white" : "border-slate-300 bg-white text-slate-700"
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
                isDark ? "border-zinc-800 bg-zinc-900/90 text-white" : "border-slate-200 bg-slate-100 text-slate-900"
              }`}
            >
              <span className={`text-[9px] font-bold uppercase ${
                !activeAccount ? "text-zinc-500" : activeAccount.account_type === "real" ? "text-zinc-400" : "text-zinc-500"
              }`}>
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
                isDark ? "border-zinc-800 bg-zinc-900 text-zinc-200" : "border-slate-300 bg-white text-slate-800 shadow-sm"
              }`}
            >
              MENU
            </button>
          </div>
        </div>

        {/* Mobile Telemetry Sub-bar (< lg screens, Dedicated Strip, Guaranteed Zero Overlap) */}
        <div className={`lg:hidden border-t mt-2 pt-1.5 flex items-center justify-between text-[11px] ${
          isDark ? "border-zinc-900 text-zinc-400" : "border-slate-100 text-slate-600"
        }`}>
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-zinc-300 animate-pulse" : "bg-zinc-500"}`} />
            <span className="font-semibold uppercase text-[10px] text-zinc-400">{botState}</span>
            <span className="text-zinc-400 text-[10px]">({runCount}/{cycleRuns})</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-500 uppercase">P/L:</span>
            <span className={`font-bold num ${totalPnl > 0 ? "text-emerald-500 font-bold" : totalPnl < 0 ? "text-red-500" : isDark ? "text-white" : "text-slate-800"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500">SPREAD:</span>
            <span className={`font-semibold num ${analysis.diff <= maxDiff ? "text-zinc-600 font-bold" : "text-zinc-500"}`}>
              {analysis.diff.toFixed(2)}%
            </span>
          </div>
        </div>
      </header>

      {/* 2. Main Content Container (Padded bottom on mobile for sticky bottom bar) */}
      <main className="mx-auto max-w-[1560px] p-3 sm:p-4 lg:p-6 pb-28 lg:pb-6">
        {/* Mobile Segmented Control Tab Switcher (< lg screens) */}
        <div className={`lg:hidden mb-4 grid grid-cols-4 gap-1 p-1 rounded-xl border text-[11px] font-bold uppercase tracking-wider ${
          isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white shadow-sm"
        }`}>
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
                  : isDark ? "text-zinc-500 hover:text-zinc-300" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {tab === "market" ? "Market" : tab === "controls" ? "Controls" : tab === "session" ? "Session" : "All"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr_290px] gap-5 lg:gap-6 items-start">

          {/* LEFT COLUMN: Controls & Settings */}
          <aside className={`space-y-5 lg:space-y-6 ${mobileTab === "controls" || mobileTab === "all" ? "block" : "hidden lg:block"}`}>
            {/* CONNECTION */}
            <section className={`rounded-xl border p-4 space-y-3 shadow-sm ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
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
                      ${Number(activeAccount?.balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
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
                    <p className="mt-1 text-[10px] text-zinc-600 leading-tight">{tradingStatusNote}</p>
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
                      {tradingReady ? "LIVE TRADING" : "AUTHED · SOCKET…"}
                    </button>
                    <button
                      onClick={refreshDerivBalances}
                      title="Sync latest balances from Deriv"
                      className={`rounded border px-3 py-2 text-xs uppercase tracking-wider transition-colors ${
                        isDark ? "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-white" : "border-slate-300 text-slate-600 hover:border-slate-400"
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
            <section className={`rounded-xl border p-4 space-y-4 shadow-sm ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                STRATEGY
              </span>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Contract & Market</label>
                <div className={`rounded border px-3 py-2 text-xs font-semibold flex items-center justify-between ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-white" : "border-slate-300 bg-slate-50 text-slate-900"
                }`}>
                  <span>Matches · Volatility 100</span>
                  <span className="text-zinc-500 text-[10px]">Vol 100</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Enter on most appearing digit, match second most digit when spread ≤ {maxDiff}%.
                </p>
              </div>

              {/* Spread Threshold Δ Selector */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">Max Spread Δ Threshold</span>
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-500 text-[10px]">Δ ≤</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={maxDiffInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^\d*\.?\d*$/.test(val)) {
                          setMaxDiffInput(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num >= 0) {
                            setMaxDiff(num);
                          }
                        }
                      }}
                      onBlur={() => {
                        const num = parseFloat(maxDiffInput);
                        if (isNaN(num) || num < 0.1) {
                          updateMaxDiff(0.3);
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
                      {val === 0.3 ? "0.3% (SPEC)" : `${val}%`}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-500 leading-tight">
                  {maxDiff === 0.3
                    ? "Strict rule: requires top 2 digits to differ by ≤ 0.3% (≤ 3 ticks out of 1,000)."
                    : `Relaxed threshold: triggers trade entry when spread is ≤ ${maxDiff}%.`}
                </p>
              </div>

              {/* Loss Protection Toggle */}
              <div className={`rounded-lg border p-3 space-y-2 ${
                isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
              }`}>
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-semibold ${isDark ? "text-zinc-300" : "text-slate-800"}`}>
                    Loss Protection
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    isDark ? "bg-zinc-800 text-zinc-400" : "bg-slate-200 text-slate-600"
                  }`}>
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
                  <span className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}>
                    Re-analyze after loss
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stopOnWin}
                    onChange={(e) => setStopOnWin(e.target.checked)}
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Pauses and re-analyzes market distribution before next trade if a loss occurs.
                </p>
              </div>

              {/* Cycle Limit & Stake */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Cycle Limit</label>
                  <div className="grid grid-cols-4 gap-1">
                    {[1, 3, 5, 10].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setCycleRuns(n)}
                        className={`rounded border py-2 text-xs font-semibold num transition-colors ${
                          cycleRuns === n
                            ? isDark
                              ? "border-zinc-600 bg-zinc-800 text-white"
                              : "border-slate-400 bg-slate-900 text-white"
                            : isDark
                              ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700"
                              : "border-slate-200 bg-slate-100 text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Stake (USD)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={stakeInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "" || /^\d*\.?\d*$/.test(val)) {
                        setStakeInput(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0) {
                          setStake(num);
                        }
                      }
                    }}
                    onBlur={() => {
                      const num = parseFloat(stakeInput);
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
                      const calculated = Math.max(0.35, Math.round((bal * (pct / 100)) * 100) / 100);
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
            <section className={`rounded-xl border p-4 space-y-3 shadow-sm ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                RISK
              </span>

              {/* Tabs */}
              <div className={`flex rounded border p-0.5 ${
                isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-100"
              }`}>
                <button
                  type="button"
                  onClick={() => setRiskTab("pnl")}
                  className={`flex-1 rounded py-1.5 text-xs font-semibold transition-colors ${
                    riskTab === "pnl"
                      ? isDark ? "bg-zinc-800 text-white shadow-sm" : "bg-white text-slate-900 shadow-sm"
                      : "text-zinc-500 hover:text-white"
                  }`}
                >
                  Profit / Loss
                </button>
                <button
                  type="button"
                  onClick={() => setRiskTab("count")}
                  className={`flex-1 rounded py-1.5 text-xs font-semibold transition-colors ${
                    riskTab === "count"
                      ? isDark ? "bg-zinc-800 text-white shadow-sm" : "bg-white text-slate-900 shadow-sm"
                      : "text-zinc-500 hover:text-white"
                  }`}
                >
                  Trade count
                </button>
              </div>

              {riskTab === "pnl" ? (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-500">Take Profit ($)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={running}
                      value={tpInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^\d*\.?\d*$/.test(val)) {
                          setTpInput(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num > 0) {
                            setTp(num);
                          }
                        }
                      }}
                      onBlur={() => {
                        const num = parseFloat(tpInput);
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
                        const val = e.target.value;
                        if (val === "" || /^\d*\.?\d*$/.test(val)) {
                          setSlInput(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num > 0) {
                            setSl(num);
                          }
                        }
                      }}
                      onBlur={() => {
                        const num = parseFloat(slInput);
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
              ) : (
                <div className="py-2 text-xs text-zinc-500">
                  Cycle Trade Limit: <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>{cycleRuns} runs per cycle</span>
                </div>
              )}
            </section>
          </aside>

          {/* CENTER COLUMN: Last Digit, Tick Stream & Trade Log */}
          <div className={`space-y-5 lg:space-y-6 min-w-0 ${mobileTab === "market" || mobileTab === "all" ? "block" : "hidden lg:block"}`}>
            {/* Top Row: Last Digit & Tick Stream Side by Side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">

              {/* CARD 1: LAST DIGIT */}
              <section className={`rounded-xl border p-4 sm:p-5 shadow-sm space-y-4 ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}>
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                      LAST DIGIT
                    </span>
                  </div>
                  <div className="text-right space-y-0.5">
                    <span className="text-[11px] font-semibold text-zinc-500">
                      {SYMBOL}
                    </span>
                    <div className="text-[10px] text-zinc-500">PRICE</div>
                    <div className={`text-sm font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                      {price !== null ? price.toFixed(2) : "—"}
                    </div>
                    <div className={`text-[11px] font-semibold num ${analysis.diff <= maxDiff ? (isDark ? "text-zinc-300" : "text-zinc-600") : "text-zinc-400"}`}>
                      SPREAD Δ {analysis.diff.toFixed(2)}% <span className="text-zinc-600">/ {maxDiff}%</span> {analysis.diff <= maxDiff ? "(READY)" : "(WAITING)"}
                    </div>
                  </div>
                </div>

                {/* Giant Digit Display */}
                <div className="flex items-baseline gap-4">
                  <span className={`text-6xl sm:text-7xl font-light tracking-tight num ${isDark ? "text-white" : "text-slate-900"}`}>
                    {currentDigit !== undefined ? currentDigit : "—"}
                  </span>
                  <div className="space-y-0.5 text-xs">
                    <div className="text-zinc-500">
                      ENTRY DIGIT: <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>{analysis.most}</span> ({analysis.mostPct.toFixed(1)}%)
                    </div>
                    <div className="text-zinc-500">
                      MATCH TARGET: <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>{analysis.second}</span> ({analysis.secondPct.toFixed(1)}%)
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
                          isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300" : "border-slate-200 bg-slate-100 text-slate-700"
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
                          isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300" : "border-slate-200 bg-slate-100 text-slate-700"
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
                                ? "border-white bg-white text-black font-bold ring-2 ring-zinc-700"
                                : "border-slate-900 bg-slate-900 text-white font-bold ring-2 ring-slate-400"
                              : isDark
                              ? "border-zinc-800 bg-zinc-900 text-zinc-300"
                              : "border-slate-200 bg-slate-100 text-slate-700"
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
              <section className={`rounded-xl border p-4 sm:p-5 shadow-sm space-y-3 ${
                isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
              }`}>
                <div className={`flex items-center justify-between border-b pb-2 ${
                  isDark ? "border-zinc-900" : "border-slate-200"
                }`}>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    TICK STREAM
                  </span>
                  <span className="text-[10px] text-zinc-500 num">
                    {digits.length >= WINDOW ? "1,000 / 1,000 (READY)" : `${digits.length} / ${WINDOW} (BUFFERING)`}
                  </span>
                </div>

                <div className="overflow-hidden text-xs num">
                  <table className="w-full text-left">
                    <tbody className={`divide-y ${isDark ? "divide-zinc-900" : "divide-slate-100"}`}>
                      {recentTicks.slice(0, 13).map((tick, idx) => (
                        <tr key={idx} className={isDark ? "hover:bg-zinc-900/50" : "hover:bg-slate-50"}>
                          <td className="py-1 text-zinc-500 text-[11px]">
                            {tick.time}
                          </td>
                          <td className={`py-1 font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}>
                            {tick.price.toFixed(2)}
                          </td>
                          <td className="py-1 text-right font-bold">
                            <span className={`inline-block px-1.5 py-0.2 rounded text-[11px] ${
                              idx === 0
                                ? isDark ? "bg-white text-black font-bold" : "bg-slate-900 text-white font-bold"
                                : "text-zinc-400"
                            }`}>
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

            {/* Bottom Row: TRADE LOG / SESSION HISTORY */}
            <section className={`rounded-xl border shadow-sm ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
              <div className={`flex items-center justify-between border-b px-4 sm:px-5 py-3 ${
                isDark ? "border-zinc-900" : "border-slate-200"
              }`}>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCenterTab("trade_log")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "trade_log"
                        ? isDark ? "bg-zinc-800 text-white" : "bg-slate-200 text-slate-900 font-bold"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    TRADE LOG
                  </button>
                  <button
                    onClick={() => setCenterTab("session_history")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "session_history"
                        ? isDark ? "bg-zinc-800 text-white" : "bg-slate-200 text-slate-900 font-bold"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    HISTORY
                  </button>
                </div>
                <span className="text-xs text-zinc-500 num">
                  {trades.length} trades
                </span>
              </div>

              <div className="p-4 sm:p-6">
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
                        <tr className={`border-b text-zinc-500 pb-2 uppercase text-[10px] ${
                          isDark ? "border-zinc-900" : "border-slate-200"
                        }`}>
                          <th className="py-2">Run</th>
                          <th>Time</th>
                          <th>Entry</th>
                          <th>Target</th>
                          <th>Exit</th>
                          <th>Stake</th>
                          <th>Status</th>
                          <th className="text-right">P/L</th>
                        </tr>
                      </thead>
                      <tbody className={`divide-y ${isDark ? "divide-zinc-900" : "divide-slate-100"}`}>
                        {trades.map((t) => (
                          <tr key={t.id} className={isDark ? "hover:bg-zinc-900/40" : "hover:bg-slate-50"}>
                            <td className={`py-2.5 font-bold ${isDark ? "text-white" : "text-slate-900"}`}>#{t.runIndex}</td>
                            <td className="text-zinc-500">{t.time}</td>
                            <td>{t.entry}</td>
                            <td className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{t.target}</td>
                            <td className={`font-bold ${isDark ? "text-white" : "text-slate-900"}`}>{t.result}</td>
                            <td>${t.stake.toFixed(2)}</td>
                            <td>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                t.pnl > 0
                                  ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                                  : "bg-red-500/15 text-red-500 border border-red-500/40"
                              }`}>
                                {t.pnl > 0 ? "WON" : "LOST"}
                              </span>
                            </td>
                            <td className={`text-right font-bold ${
                              t.pnl > 0
                                ? "text-emerald-500"
                                : "text-red-500"
                            }`}>
                              {t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN: Session & Bot Overview */}
          <aside className={`space-y-5 lg:space-y-6 ${mobileTab === "session" || mobileTab === "all" ? "block" : "hidden lg:block"}`}>
            {/* SESSION */}
            <section className={`rounded-xl border p-4 space-y-4 shadow-sm ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                SESSION
              </span>

              {/* Net P/L Hero Card */}
              <div className={`rounded-xl border p-4 space-y-2 ${
                isDark ? "border-zinc-800 bg-black" : "border-slate-200 bg-slate-50"
              }`}>
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-zinc-500">NET P/L</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    totalPnl >= 0
                      ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                      : "bg-red-500/15 text-red-500 border border-red-500/40"
                  }`}>
                    {totalPnl >= 0 ? "PROFIT" : "LOSS"}
                  </span>
                </div>
                <div className={`text-3xl font-light tracking-tight num ${totalPnl > 0 ? "text-emerald-500" : totalPnl < 0 ? "text-red-500" : isDark ? "text-white" : "text-slate-900"}`}>
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} <span className="text-xs font-normal text-zinc-500">USD</span>
                </div>
              </div>

              {/* 2x2 Stats Grid */}
              <div className="grid grid-cols-2 gap-3 num">
                <div className={`rounded-lg border p-3 ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}>
                  <span className="text-[10px] font-semibold text-zinc-500">WINS</span>
                  <div className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}>{wins}</div>
                </div>

                <div className={`rounded-lg border p-3 ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}>
                  <span className="text-[10px] font-semibold text-zinc-500">LOSSES</span>
                  <div className="text-2xl font-light text-zinc-400 mt-1">{losses}</div>
                </div>

                <div className={`rounded-lg border p-3 ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}>
                  <span className="text-[10px] font-semibold text-zinc-500">TRADES</span>
                  <div className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}>{trades.length}</div>
                </div>

                <div className={`rounded-lg border p-3 ${
                  isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
                }`}>
                  <span className="text-[10px] font-semibold text-zinc-500">WIN RATE</span>
                  <div className={`text-2xl font-light mt-1 ${isDark ? "text-white" : "text-slate-900"}`}>{winRate}%</div>
                </div>
              </div>
            </section>

            {/* BOT (Clean Strategy Telemetry - No Reps) */}
            <section className={`rounded-xl border p-4 space-y-3.5 shadow-sm text-xs num ${
              isDark ? "border-zinc-900 bg-zinc-950" : "border-slate-200 bg-white"
            }`}>
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                BOT TELEMETRY
              </span>

              <div className="grid grid-cols-2 gap-y-3 gap-x-2">
                <div>
                  <div className="text-[10px] text-zinc-500">Status</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{botState}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">1,000 Ticks</div>
                  <div className={`font-semibold ${digits.length >= WINDOW ? "text-zinc-400" : "text-amber-500"}`}>
                    {digits.length >= WINDOW ? "VERIFIED" : `${digits.length}/${WINDOW}`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Pending</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{pending.current ? "yes" : "no"}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Mode</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>Matches</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Cycle Progress</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{runCount} / {cycleRuns} runs</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Entry Digit</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{analysis.most} ({analysis.mostPct.toFixed(1)}%)</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Match Target</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{analysis.second} ({analysis.secondPct.toFixed(1)}%)</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Spread Threshold</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>Δ ≤ {maxDiff}%</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Symbol</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{SYMBOL}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Duration</div>
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>1 tick</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Feed Status</div>
                  <div className="font-semibold text-zinc-600 uppercase">{status}</div>
                </div>
              </div>

              {/* Bot Status Note */}
              <div className={`rounded-lg border p-2.5 mt-2 text-[11px] leading-relaxed ${
                isDark ? "border-zinc-900 bg-black text-zinc-400" : "border-slate-200 bg-slate-50 text-slate-600"
              }`}>
                {note}
              </div>
            </section>
          </aside>
        </div>
        {/* Footer */}
        <footer className={`mt-10 pt-6 border-t text-center font-mono text-xs transition-colors ${
          isDark ? "border-zinc-900 text-zinc-500" : "border-slate-200 text-slate-500"
        }`}>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5">
            <span>Built by</span>
            <a
              href="https://architeq.co.za"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-zinc-400 hover:text-zinc-300 hover:underline transition-colors"
            >
              Architeq Web Agency ↗
            </a>
          </div>
        </footer>
      </main>

      {/* 3. Mobile Sticky Bottom Action Bar (Thumb-Friendly Single Row) */}
      <div className={`lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t safe-bottom backdrop-blur-md transition-colors ${
        isDark ? "border-zinc-900 bg-black/95 text-white" : "border-slate-200 bg-white/95 text-slate-900 shadow-2xl"
      }`}>
        <div className="px-3 py-2 flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={() => stopBot("User stopped bot.")}
              className="flex-1 h-12 rounded-xl bg-rose-600 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
              STOP BOT ({runCount}/{cycleRuns})
            </button>
          ) : (
            <button
              type="button"
              onClick={startBot}
              disabled={digits.length < WINDOW}
              className="flex-1 h-12 rounded-xl bg-white px-4 text-xs font-bold uppercase tracking-wider text-black shadow-md active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span className={`h-2 w-2 rounded-full ${digits.length >= WINDOW ? "bg-white" : "bg-amber-300"}`} />
              {digits.length < WINDOW ? `BUFFERING (${digits.length}/${WINDOW})` : "START BOT"}
            </button>
          )}

          <button
            type="button"
            onClick={resetSession}
            title="Reset session"
            className={`h-12 px-4 rounded-xl border text-xs font-bold uppercase tracking-wider transition-colors ${
              isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white" : "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            RESET
          </button>

          <button
            type="button"
            onClick={triggerManualTestTrade}
            disabled={digits.length < WINDOW || pending.current !== null}
            title="Run 1 test trade"
            className={`h-12 px-4 rounded-xl border text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 ${
              isDark ? "border-zinc-700 bg-zinc-900 text-zinc-300" : "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            TEST 1
          </button>
        </div>
      </div>

      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className={`w-full max-w-md border p-5 sm:p-6 space-y-5 shadow-2xl ${
            isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-300 bg-white text-slate-900"
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? "border-zinc-900" : "border-slate-200"
            }`}>
              <div className="space-y-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Deriv</span>
                <h3 className="font-display text-sm font-semibold uppercase tracking-wider">Connect account</h3>
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
                  Authenticate securely via Deriv Auth 2.0 PKCE. All trading permissions and demo/real accounts will be loaded automatically.
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
                Redirects to Deriv login. Demo and real accounts will be synchronized immediately upon return.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 5. Mobile Menu & Settings Drawer (< lg screens) */}
      {showMobileMenu && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-sm lg:hidden">
          <div className={`w-full max-w-lg rounded-t-2xl border-t p-5 space-y-4 shadow-2xl safe-bottom animate-in slide-in-from-bottom duration-200 ${
            isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-300 bg-white text-slate-900"
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? "border-zinc-900" : "border-slate-200"
            }`}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-zinc-300" />
                <span className="text-xs font-bold uppercase tracking-wider">Terminal Settings</span>
              </div>
              <button
                onClick={() => setShowMobileMenu(false)}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [CLOSE]
              </button>
            </div>

            {/* Switch Account */}
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">Switch Account</label>
              <select
                value={activeId || ""}
                onChange={(e) => switchAccount(e.target.value)}
                className={`w-full rounded border p-2.5 text-xs font-semibold outline-none ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-white" : "border-slate-300 bg-white text-slate-900"
                }`}
              >
                {accounts.map((acc) => (
                  <option key={acc.account_id} value={acc.account_id}>
                    {acc.account_id} ({acc.account_type === "real" ? "Real" : "Demo"}) — ${Number(acc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
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
                    ? isDark ? "border-zinc-600 bg-zinc-900 text-zinc-300" : "border-zinc-500 bg-zinc-100 text-zinc-800"
                    : isDark ? "border-zinc-800 bg-zinc-900 text-zinc-400" : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${notifsEnabled ? "bg-zinc-300 animate-pulse" : "bg-zinc-600"}`} />
                NOTIF: {notifsEnabled ? "ON" : "OFF"}
              </button>

              <button
                type="button"
                onClick={toggleSound}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 ${
                  soundEnabled
                    ? isDark ? "border-zinc-700 bg-zinc-900 text-zinc-200" : "border-slate-300 bg-slate-100 text-slate-800"
                    : isDark ? "border-zinc-800 text-zinc-500" : "border-slate-200 text-slate-400"
                }`}
              >
                SOUND: {soundEnabled ? "ON" : "OFF"}
              </button>

              <button
                type="button"
                onClick={toggleTheme}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-zinc-200" : "border-slate-300 bg-slate-100 text-slate-800"
                }`}
              >
                THEME: {isDark ? "DARK" : "LIGHT"}
              </button>

              <button
                type="button"
                onClick={runBacktest1000Ticks}
                className={`rounded border p-2.5 text-xs font-bold uppercase tracking-wider ${
                  isDark ? "border-zinc-800 bg-zinc-900 text-zinc-200" : "border-slate-300 bg-slate-100 text-slate-800"
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
                isDark ? "border-zinc-700 text-zinc-300 bg-zinc-900/40" : "border-zinc-300 text-zinc-800 bg-zinc-100"
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
            <div className={`pt-2 border-t text-center font-mono text-[11px] ${
              isDark ? "border-zinc-900 text-zinc-500" : "border-slate-200 text-slate-500"
            }`}>
              <span>Built by </span>
              <a
                href="https://architeq.co.za"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-zinc-300 font-bold hover:underline"
              >
                Architeq Web Agency ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* 6. Backtest / Test Results Modal */}
      {showBacktestModal && backtest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className={`w-full max-w-lg rounded-xl border p-5 sm:p-6 space-y-5 shadow-2xl ${
            isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-200 bg-white text-slate-900"
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? "border-zinc-900" : "border-slate-200"
            }`}>
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? "text-white" : "text-slate-900"}`}>
                1,000 TICKS BACKTEST RESULTS
              </span>
              <button
                onClick={() => setShowBacktestModal(false)}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [X]
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Calculated across the latest {backtest.totalTicks} real market ticks of Volatility 100 Index using the Deriv Matches strategy (spread ≤ {maxDiff}%, enter on most appearing digit, target second most appearing digit):
            </p>

            <div className={`grid grid-cols-2 gap-4 rounded border p-4 num ${
              isDark ? "border-zinc-900 bg-black" : "border-slate-200 bg-slate-50"
            }`}>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Signals Found</span>
                <div className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}>{backtest.signals}</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Win Rate</span>
                <div className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}>{backtest.winRate.toFixed(1)}%</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Wins / Losses</span>
                <div className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}>{backtest.wins}W · {backtest.losses}L</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Simulated Net P/L</span>
                <div className={`text-2xl font-light ${backtest.netPnl > 0 ? "text-emerald-500" : backtest.netPnl < 0 ? "text-red-500" : isDark ? "text-white" : "text-slate-900"}`}>
                  {backtest.netPnl >= 0 ? "+" : ""}${backtest.netPnl.toFixed(2)}
                </div>
              </div>
            </div>

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
          <div className={`w-full max-w-sm rounded-xl border p-5 sm:p-6 space-y-4 shadow-2xl ${
            isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-300 bg-white text-slate-900"
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? "border-zinc-900" : "border-slate-200"
            }`}>
              <span className="text-xs font-bold uppercase tracking-wider">
                Install on iOS
              </span>
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
              <li>Tap the <span className="font-semibold text-zinc-300">Share</span> button in Safari's bottom toolbar.</li>
              <li>Scroll down and select <span className="font-semibold text-zinc-300">Add to Home Screen</span>.</li>
              <li>Tap <span className="font-semibold text-zinc-300">Add</span> in the top-right corner.</li>
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
