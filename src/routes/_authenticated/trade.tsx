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
  getActiveAccountType,
  getStoredAuthInfo,
  fetchDerivAccounts,
  HARDCODED_APP_ID,
  clearAllDerivAuth,
  handleIncomingOAuth,
  authorizeWithToken,
  getManualToken,
  type DerivAccount,
} from "@/lib/deriv-auth";
import { DerivWS } from "@/lib/deriv-ws";
import { analyze, lastDigit, shouldEnter, MAX_DIFF, MAX_RUNS, SYMBOL, WINDOW } from "@/lib/matches";
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
  isSoundEnabled,
  setSoundEnabled,
  playAlertSound,
  dispatchNotification,
  onInAppAlert,
  initAudioContext,
  isIOSSafariNotPWA,
} from "@/lib/notifications";
import {
  isRunningStandalone,
  isIOS,
  onInstallableChange,
  triggerInstallPrompt,
} from "@/lib/pwa";

export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({
    meta: [
      { title: "ThDpst Matches // Volatility 100" },
      { name: "description", content: "Deriv Matches smart trader bot for Volatility 100." },
    ],
  }),
  component: TradeTerminal,
});

/**
 * Deriv Digit Matches contract payout pricing:
 * Deriv charges an 11.20% probability rate for Digit Match (1 out of 10 digits).
 * Base Gross Payout = Stake / 0.1120 = Stake * 8.9285714...
 *
 * Developer App Markup:
 * Configured dynamically by Deriv App ID (registered on Deriv Developer Portal).
 * Markup Fee = Gross Payout * Markup%
 * Effective Client Payout = Gross Payout * (1 - Markup%)
 * Net Win Profit (P/L) = Effective Client Payout - Stake
 */
export const DERIV_MATCH_BASE_PAYOUT_RATIO = 100 / 11.20; // 8.92857142857

export function calculateMatchesPayout(
  stake: number,
  markupPercent: number = getAppIdMarkup()
) {
  const baseGrossPayout = stake * DERIV_MATCH_BASE_PAYOUT_RATIO;
  const markupRate = markupPercent / 100;
  const clientGrossPayout = Math.round(baseGrossPayout * (1 - markupRate) * 100) / 100;
  const netWinProfit = Math.round((clientGrossPayout - stake) * 100) / 100;
  const markupFee = Math.round(baseGrossPayout * markupRate * 100) / 100;
  return {
    baseGrossPayout,
    clientGrossPayout,
    netWinProfit,
    markupFee,
    markupPercent,
    payoutMultiplier: stake > 0 ? clientGrossPayout / stake : 0,
  };
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

export function TradeTerminal() {
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

  // Deriv connection modal (OAuth + Direct API Token authorization)
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSuccess, setTokenSuccess] = useState<string | null>(null);

  // In-app alert banner
  const [inAppAlert, setInAppAlert] = useState<{ id: number; title: string; body: string; type: string } | null>(null);

  // Mobile settings drawer/modal
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // App ID and configured markup dynamically resolved for this application
  const activeAppId = getDerivClientId();
  const [configuredMarkup, setConfiguredMarkup] = useState<number>(() => getAppIdMarkup(activeAppId));

  // Derive activeAccount and activeType safely (guaranteed 100% in sync)
  const activeAccount = accounts.find((a) => a.account_id === activeId) || accounts[0];
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
  const [botState, setBotState] = useState<"IDLE" | "BUFFERING" | "ANALYZING" | "WAITING ENTRY" | "IN TRADE" | "LOSS RE-ANALYSIS" | "COMPLETED">("BUFFERING");
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
        dispatchNotification("Notifications Enabled", {
          body: "You will receive real-time alerts for trade wins, losses, and cycle limits.",
        });
      } else if (perm === "denied") {
        alert("Notifications are blocked in your browser or device settings. Please allow notifications for this site to receive trade alerts.");
      } else if (perm === "unsupported") {
        setShowIOSInstallGuide(true);
      }
    } else {
      setNotificationEnabled(false);
      setNotifsEnabled(false);
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
  const lossCooldownTicks = useRef(0);
  const wsRef = useRef<DerivWS | null>(null);

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
  };

  // Refresh live balances from Deriv API / WebSocket
  const refreshDerivBalances = useCallback(async () => {
    const manualToken = getManualToken();
    const authInfo = getStoredAuthInfo();
    const token = authInfo?.access_token || manualToken;
    if (token) {
      try {
        const res = await authorizeWithToken(token);
        if (res.success && res.accounts.length > 0) {
          setAccounts((prev) => {
            return res.accounts.map((fresh) => {
              if (fresh.account_type === "demo") {
                const existing = prev.find((p) => p.account_id === fresh.account_id);
                if (existing && existing.balance !== undefined) {
                  return { ...fresh, balance: existing.balance };
                }
              }
              return fresh;
            });
          });
        }
      } catch {
        // Keep current balances
      }
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
            const chosen = saved.find((a) => a.account_id === storedActive) || saved[0];
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

    if (savedAccounts.length > 0) {
      setAccounts(savedAccounts);
      const chosen = savedAccounts.find((a) => a.account_id === storedActive) || savedAccounts[0];
      setActiveId(chosen.account_id);
      setIsConnectedToDeriv(Boolean(authInfo || manualToken));
    } else {
      const initialMock: DerivAccount[] = [
        { account_id: "VRTC1029384", account_type: "demo", currency: "USD", balance: "10000.00" },
        { account_id: "CR91945350", account_type: "real", currency: "USD", balance: "0.00" },
      ];
      storeAccounts(initialMock);
      setAccounts(initialMock);
      setActiveId("VRTC1029384");
      setIsConnectedToDeriv(Boolean(manualToken));
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
      const pData = data.proposal as { payout?: number; ask_price?: number };
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

    // Listen for balance updates from Deriv (applies to real accounts, preserves demo trading)
    ws.registerHandler("balance", (data) => {
      const bData = data.balance as {
        accounts?: Record<string, { balance: number; currency: string }>;
        balance?: number;
        loginid?: string;
      };
      if (bData?.accounts) {
        setAccounts((prev) => {
          const updated = prev.map((acc) => {
            if (acc.account_type === "demo") return acc; // Preserve active demo trading balance
            const fresh = bData.accounts?.[acc.account_id];
            if (fresh) {
              return { ...acc, balance: Number(fresh.balance).toFixed(2), currency: fresh.currency || acc.currency };
            }
            return acc;
          });
          storeAccounts(updated);
          return updated;
        });
      } else if (typeof bData?.balance === "number" && bData.loginid) {
        setAccounts((prev) => {
          const updated = prev.map((acc) => {
            if (acc.account_type === "demo") return acc; // Preserve active demo trading balance
            if (acc.account_id === bData.loginid) {
              return { ...acc, balance: Number(bData.balance).toFixed(2) };
            }
            return acc;
          });
          storeAccounts(updated);
          return updated;
        });
      }
    });

    // Listen for tick history and incoming live ticks
    ws.registerHandler("history", (data) => {
      const history = data.history as { prices?: number[]; times?: number[] };
      if (history?.prices && history.prices.length > 0) {
        const pList = history.prices;
        const tList = history.times || [];
        const dList = pList.map((p) => lastDigit(p));
        setDigits(dList);
        setPrice(pList[pList.length - 1] ?? null);

        // Prepopulate tick stream strictly in chronological order (newest first for table)
        const initialTicks: TickItem[] = [];
        const count = Math.min(15, pList.length);
        for (let i = pList.length - count; i < pList.length; i++) {
          const timestamp = tList[i] ? new Date(tList[i] * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
          initialTicks.unshift({
            time: timestamp,
            price: pList[i],
            digit: dList[i],
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
      const tick = data.tick as { quote?: number; epoch?: number };
      if (typeof tick?.quote === "number") {
        const q = tick.quote;
        const timeStr = tick.epoch ? new Date(tick.epoch * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
        const nextDigit = lastDigit(q);

        setPrice(q);

        // Tick stream: prepend latest incoming tick to top
        setRecentTicks((prev) => [{ time: timeStr, price: q, digit: nextDigit }, ...prev.slice(0, 14)]);

        // Digits stream: append in strict incoming chronological sequence
        let updatedDigits: number[] = [];
        setDigits((prev) => {
          const next = [...prev, nextDigit];
          if (next.length > WINDOW) next.shift();
          updatedDigits = next;
          return next;
        });

        // Process trade logic OUTSIDE of setDigits to ensure state updates (balance, trades) are not batched/deferred
        setTimeout(() => {
          if (updatedDigits.length > 0) {
            handleTickEvent(updatedDigits, q, nextDigit);
          }
        }, 0);
      }
    });

    // Request 1000 ticks history & subscribe to live stream
    ws.send({
      ticks_history: SYMBOL,
      count: WINDOW,
      end: "latest",
      style: "ticks",
      subscribe: 1,
    }).catch((err) => console.error("Ticks subscription error:", err));

    return () => {
      ws.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request live contract proposal from Deriv when connected and when stake changes
  useEffect(() => {
    if (status === "live" && wsRef.current) {
      wsRef.current.send({
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: "DIGITMATCH",
        currency: activeAccount?.currency || "USD",
        duration: 1,
        duration_unit: "t",
        underlying_symbol: "R_100",
        barrier: "5",
      }).catch(() => {});
    }
  }, [status, stake, activeAccount?.currency]);

  function handleTickEvent(tickList: number[], _currentPrice: number, currentD: number) {
    const s = stateRef.current;

    // 1. Settle in-flight trade on the tick following entry
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      const won = currentD === p.target;
      const { netWinProfit } = calculateMatchesPayout(p.stake, s.configuredMarkup);
      const pnl = won ? netWinProfit : -p.stake;

      if (won) {
        notifyTradeWon(p.runIndex, netWinProfit, p.target);
      } else {
        notifyTradeLost(p.runIndex, p.stake, currentD, p.target);
      }

      const newRow: TradeRow = {
        id: Date.now(),
        runIndex: p.runIndex,
        entry: p.entry,
        target: p.target,
        result: currentD,
        stake: p.stake,
        pnl,
        time: new Date().toLocaleTimeString(),
      };

      const updatedTrades = [newRow, ...s.trades];
      setTrades(updatedTrades);

      // Auto-update amounts for active Demo or Real account
      setAccounts((prev) => {
        const targetId = s.activeId || activeId || (prev[0] ? prev[0].account_id : "");
        const updated = prev.map((acc) => {
          if (acc.account_id === targetId || (!targetId && acc === prev[0])) {
            const currentBal = parseFloat(acc.balance) || 0;
            const nextBal = Math.max(0, currentBal + pnl);
            return { ...acc, balance: nextBal.toFixed(2) };
          }
          return acc;
        });
        storeAccounts(updated);
        return updated;
      });

      const totalPnl = updatedTrades.reduce((acc, t) => acc + t.pnl, 0);
      const nextRunCount = s.runCount + 1;
      setRunCount(nextRunCount);

      // Check Risk Limits
      if (totalPnl >= s.tp) {
        notifyTakeProfit(totalPnl);
        return stopBot(`Take Profit reached (+$${totalPnl.toFixed(2)})`);
      }
      if (totalPnl <= -s.sl) {
        notifyStopLoss(totalPnl);
        return stopBot(`Stop Loss reached (-$${Math.abs(totalPnl).toFixed(2)})`);
      }
      if (nextRunCount >= MAX_RUNS) {
        notifyCycleCompleted(MAX_RUNS, totalPnl);
        return stopBot(`Cycle completed: ${MAX_RUNS} runs finished (Total: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)})`);
      }

      // Re-analysis rule on loss
      if (!won && s.reAnalyzeOnLoss) {
        lossCooldownTicks.current = 5;
        setBotState("LOSS RE-ANALYSIS");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Lost (${currentD} ≠ ${p.target}). Re-analyzing market distribution...`);
        return;
      } else {
        setBotState("ANALYZING");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Won (+${pnl.toFixed(2)} USD). Analyzing market for run ${nextRunCount + 1}...`);
        return;
      }
    }

    if (!s.running) return;

    // Strict 1,000-tick requirement: The bot must analyse the last 1,000 ticks before evaluating trade entry
    if (tickList.length < WINDOW) {
      setBotState("BUFFERING");
      setNote(`Buffering market ticks (${tickList.length}/${WINDOW}). Analyzing last 1,000 ticks before evaluating entry...`);
      return;
    }

    if (s.botState === "LOSS RE-ANALYSIS") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setNote(`Loss re-analysis: streaming fresh ticks (${lossCooldownTicks.current} remaining)...`);
        return;
      }
    }

    const a = analyze(tickList, s.maxDiff);

    if (shouldEnter(a, currentD)) {
      const targetRun = s.runCount + 1;
      pending.current = {
        runIndex: targetRun,
        entry: currentD,
        target: a.second,
        stake: s.stake,
      };
      setBotState("IN TRADE");
      setNote(`Run ${targetRun}/${MAX_RUNS}: Entered on digit ${currentD}. Matching target ${a.second}...`);
    } else if (a.ok) {
      setBotState("WAITING ENTRY");
      setNote(`Spread verified (Δ ${a.diff.toFixed(2)}% ≤ ${s.maxDiff}%). Waiting for entry digit ${a.most}...`);
    } else {
      setBotState("ANALYZING");
      setNote(`Spread Δ ${a.diff.toFixed(2)}% > ${s.maxDiff}%. Analyzing last 1,000 ticks...`);
    }
  }

  function startBot() {
    initAudioContext();
    if (digits.length < WINDOW) {
      setNote(`Cannot start bot: Buffering market ticks (${digits.length}/${WINDOW}). Exactly 1,000 ticks must be analyzed before entering a trade.`);
      return;
    }
    setTrades([]);
    setRunCount(0);
    pending.current = null;
    lossCooldownTicks.current = 0;
    setRunning(true);
    setBotState("ANALYZING");
    setNote("Bot active. Evaluating last 1,000 ticks of Volatility 100 for Run 1...");
  }

  function stopBot(message: string) {
    setRunning(false);
    setBotState("IDLE");
    setNote(message);
    pending.current = null;
  }

  function resetSession() {
    stopBot("Session reset.");
    setTrades([]);
    setRunCount(0);
  }

  // Refill demo balance back to $10,000.00
  function resetDemoBalance() {
    setAccounts((prev) => {
      const updated = prev.map((acc) => {
        if (acc.account_type === "demo") {
          return { ...acc, balance: "10000.00" };
        }
        return acc;
      });
      storeAccounts(updated);
      return updated;
    });
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
      const newAcc: DerivAccount = {
        account_id: targetType === "demo" ? "VRTC1029384" : "CR91945350",
        account_type: targetType,
        currency: "USD",
        balance: targetType === "demo" ? "10000.00" : "0.00",
        status: "active",
      };
      setAccounts((prev) => {
        const updated = [...prev, newAcc];
        storeAccounts(updated);
        return updated;
      });
      switchAccount(newAcc.account_id);
    }
  }

  function triggerManualTestTrade() {
    initAudioContext();
    if (digits.length < WINDOW) {
      alert(`Buffering market ticks (${digits.length}/${WINDOW}). Exactly 1,000 ticks required.`);
      return;
    }
    const a = analyze(digits, maxDiff);
    const targetRun = (runCount % MAX_RUNS) + 1;
    pending.current = {
      runIndex: targetRun,
      entry: a.most,
      target: a.second,
      stake,
    };
    setBotState("IN TRADE");
    setNote(`Test run ${targetRun}/${MAX_RUNS}: Entered on digit ${a.most}. Matching second most digit ${a.second} on next tick...`);
  }

  async function handleDirectOAuth() {
    try {
      await startDerivAuth({
        clientId: getDerivClientId(),
        redirectUri: derivRedirectUri(),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to initiate Deriv Auth 2.0");
    }
  }

  async function handleAuthorizeWithTokenSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiTokenInput.trim()) return;

    setTokenBusy(true);
    setTokenError(null);
    setTokenSuccess(null);

    try {
      const res = await authorizeWithToken(apiTokenInput.trim());
      if (res.success) {
        setIsConnectedToDeriv(true);
        setAccounts(res.accounts);
        if (res.activeAccount) {
          setActiveId(res.activeAccount.account_id);
        }
        setTokenSuccess("Successfully authorized and connected Deriv account!");
        setTimeout(() => {
          setShowConnectModal(false);
          setTokenSuccess(null);
          setApiTokenInput("");
        }, 1200);
      } else {
        setTokenError(res.error || "Failed to authorize token.");
      }
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Authorization error.");
    } finally {
      setTokenBusy(false);
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
    <div className={`min-h-screen font-mono antialiased transition-colors overflow-x-hidden ${
      isDark ? "bg-black text-white" : "bg-[#f4f6f8] text-slate-800"
    }`}>
      {/* Floating In-App Alert Toast (Cross-device feedback) */}
      {inAppAlert && (
        <aside
          role="status"
          aria-live="polite"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-md animate-in fade-in slide-in-from-top-4 duration-200"
        >
          <div className={`rounded-lg border px-4 py-3 shadow-2xl flex items-start justify-between gap-3 ${
            inAppAlert.type === "win"
              ? isDark ? "border-teal-700 bg-zinc-950 text-teal-300" : "border-teal-500 bg-teal-50 text-teal-900"
              : inAppAlert.type === "loss"
              ? isDark ? "border-zinc-800 bg-zinc-950 text-zinc-300" : "border-slate-300 bg-white text-slate-800"
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
            <span className={`h-2 w-2 rounded-full ${status === "live" ? "bg-teal-500" : "bg-amber-500"}`} />
            <span className={`text-xs sm:text-sm font-bold tracking-wider uppercase ${isDark ? "text-white" : "text-slate-900"}`}>
              ThDpst Matches <span className="hidden md:inline font-normal text-zinc-500">// Volatility 100</span>
            </span>
          </div>

          {/* Desktop Bot Telemetry Pill (lg screens only) */}
          <div className={`hidden xl:flex min-w-0 items-center gap-2 border-l pl-3 text-xs ${
            isDark ? "border-zinc-800" : "border-slate-200"
          }`}>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-teal-400 animate-pulse" : "bg-zinc-600"}`} />
              <span className="font-semibold text-zinc-400 uppercase text-[11px]">{botState}</span>
            </div>
            <span className={isDark ? "text-zinc-800" : "text-slate-300"}>|</span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500 text-[11px]">P/L</span>
              <span className={`font-semibold num ${
                totalPnl > 0
                  ? isDark ? "text-white font-bold" : "text-teal-700 font-bold"
                  : totalPnl < 0 ? "text-zinc-400" : isDark ? "text-white" : "text-slate-700"
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
              <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
              <span className="text-zinc-500">{activeAccount?.currency || "USD"}</span>
              <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                {activeAccount?.balance ? Number(activeAccount.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "0.00"}
              </span>
            </div>

            {/* Account Switcher Dropdown */}
            <select
              value={activeId || ""}
              onChange={(e) => switchAccount(e.target.value)}
              className={`rounded border px-2 py-1.5 text-xs font-medium outline-none transition-colors ${
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
              title={notifsEnabled ? "Notifications enabled" : "Enable cross-device notifications"}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                notifsEnabled
                  ? isDark ? "border-teal-700 bg-teal-950/40 text-teal-300 font-bold" : "border-teal-500 bg-teal-50 text-teal-800 font-bold"
                  : isDark ? "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-white" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${notifsEnabled ? "bg-teal-400 animate-pulse" : "bg-zinc-600"}`} />
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
                className="rounded bg-teal-600 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors shadow-sm"
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
                  className="rounded bg-teal-600 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
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
                  isDark ? "border-teal-900 bg-teal-950/40 text-teal-300 hover:border-teal-700" : "border-teal-300 bg-teal-50 text-teal-800"
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
            <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${
              isDark ? "border-zinc-800 bg-zinc-900/90 text-white" : "border-slate-200 bg-slate-100 text-slate-900"
            }`}>
              <span className={`text-[9px] font-bold uppercase ${activeAccount?.account_type === "real" ? "text-teal-500" : "text-zinc-500"}`}>
                {activeAccount?.account_type === "real" ? "Real" : "Demo"}
              </span>
              <span className="num">
                ${activeAccount?.balance ? Number(activeAccount.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "0.00"}
              </span>
            </div>

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
            <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-teal-400 animate-pulse" : "bg-zinc-500"}`} />
            <span className="font-semibold uppercase text-[10px] text-zinc-400">{botState}</span>
            <span className="text-zinc-400 text-[10px]">({runCount}/{MAX_RUNS})</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-500 uppercase">P/L:</span>
            <span className={`font-bold num ${totalPnl > 0 ? "text-teal-600 font-bold" : totalPnl < 0 ? "text-zinc-500" : isDark ? "text-white" : "text-slate-800"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500">SPREAD:</span>
            <span className={`font-semibold num ${analysis.diff <= maxDiff ? "text-teal-600 font-bold" : "text-zinc-500"}`}>
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
                    ? "bg-zinc-800 text-teal-400 font-bold shadow-sm"
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
                {activeType === "demo" && (
                  <button
                    onClick={resetDemoBalance}
                    title="Reset demo virtual balance to $10,000"
                    className="text-[10px] text-teal-500 hover:underline uppercase font-bold"
                  >
                    RESET $10K
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">Active Account (Tap to Switch)</label>
                {/* Clickable Card to switch Demo / Real */}
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
                      {activeAccount?.account_id} ({activeType === "real" ? "Real" : "Demo"})
                    </span>
                    <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                      ${Number(activeAccount?.balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500 leading-tight">
                    {activeType === "real"
                      ? "Live trading uses real funds. Trade at your own risk."
                      : "Virtual trading environment with simulated balance."}
                  </p>
                </div>
              </div>

              {isConnectedToDeriv ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      disabled
                      className={`flex-1 rounded border py-2 text-xs font-medium uppercase tracking-wider ${
                        isDark ? "border-teal-900/60 bg-teal-950/30 text-teal-400" : "border-teal-200 bg-teal-50 text-teal-700"
                      }`}
                    >
                      CONNECTED
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
                    Change Account / API Token
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowConnectModal(true)}
                  className="w-full rounded bg-teal-600 py-2.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors shadow-sm"
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
                  <span className="text-zinc-500 text-[10px]">R_100</span>
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
                          ? "border-zinc-800 bg-black text-teal-400 focus:border-zinc-600"
                          : "border-slate-300 bg-white text-teal-700 focus:border-slate-500"
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
                            ? "border-teal-500 bg-teal-500/20 text-teal-300 font-bold"
                            : "border-teal-600 bg-teal-50 text-teal-800 font-bold"
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
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-teal-600 focus:ring-teal-500"
                  />
                  <span className={`text-xs font-medium ${isDark ? "text-zinc-300" : "text-slate-800"}`}>
                    Re-analyze after loss
                  </span>
                </label>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Pauses and re-analyzes market distribution before next trade if a loss occurs.
                </p>
              </div>

              {/* Cycle Limit & Stake */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-500">Cycle Limit</label>
                  <div className={`w-full rounded border px-3 py-2 text-sm font-semibold num ${
                    isDark ? "border-zinc-800 bg-zinc-900 text-zinc-300" : "border-slate-200 bg-slate-100 text-slate-800"
                  }`}>
                    3 runs
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
                      const bal = activeAccount ? Number(activeAccount.balance) || 100 : 100;
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

              {/* Live Deriv Matches Payout Breakdown with App ID Configured Markup */}
              {(() => {
                const payoutInfo = calculateMatchesPayout(stake, configuredMarkup);
                return (
                  <div className={`mt-3 rounded-lg border p-3 space-y-2 ${
                    isDark ? "border-zinc-800/80 bg-zinc-900/60" : "border-slate-200 bg-slate-50"
                  }`}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 font-medium">Potential Payout</span>
                      <span className={`font-bold num ${isDark ? "text-teal-400" : "text-teal-700"}`}>
                        ${payoutInfo.clientGrossPayout.toFixed(2)} USD
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500 font-medium">Net Profit / Win</span>
                      <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>
                        +${payoutInfo.netWinProfit.toFixed(2)} USD
                        <span className="ml-1 text-[10px] text-zinc-500 font-normal">
                          (+{((payoutInfo.netWinProfit / (stake || 1)) * 100).toFixed(0)}%)
                        </span>
                      </span>
                    </div>
                    <div className={`pt-2 border-t flex items-center justify-between text-[10px] text-zinc-500 ${
                      isDark ? "border-zinc-800/60" : "border-slate-200"
                    }`}>
                      <span>Markup ({configuredMarkup.toFixed(1)}%): -${payoutInfo.markupFee.toFixed(2)}</span>
                      <span>Effective: {payoutInfo.payoutMultiplier.toFixed(2)}x</span>
                    </div>
                  </div>
                );
              })()}
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
                  Cycle Trade Limit: <span className={`font-bold num ${isDark ? "text-white" : "text-slate-900"}`}>3 runs per cycle</span>
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
                    <div className={`text-[11px] font-semibold num ${analysis.diff <= maxDiff ? (isDark ? "text-teal-400" : "text-teal-600") : "text-zinc-400"}`}>
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
                                  ? isDark ? "bg-white text-black" : "bg-slate-900 text-white"
                                  : "border border-zinc-700 text-zinc-400"
                              }`}>
                                {t.pnl > 0 ? "WON" : "LOST"}
                              </span>
                            </td>
                            <td className={`text-right font-bold ${
                              t.pnl > 0
                                ? isDark ? "text-white" : "text-teal-700"
                                : "text-zinc-500"
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
                      ? isDark ? "bg-zinc-800 text-white" : "bg-slate-200 text-slate-800"
                      : "border border-zinc-700 text-zinc-400"
                  }`}>
                    {totalPnl >= 0 ? "PROFIT" : "LOSS"}
                  </span>
                </div>
                <div className={`text-3xl font-light tracking-tight num ${isDark ? "text-white" : "text-slate-900"}`}>
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
                  <div className={`font-semibold ${digits.length >= WINDOW ? "text-teal-500" : "text-amber-500"}`}>
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
                  <div className={`font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>{runCount} / {MAX_RUNS} runs</div>
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
                  <div className="font-semibold text-teal-600 uppercase">{status}</div>
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
              className="font-bold text-teal-500 hover:text-teal-400 hover:underline transition-colors"
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
              STOP BOT ({runCount}/{MAX_RUNS})
            </button>
          ) : (
            <button
              type="button"
              onClick={startBot}
              disabled={digits.length < WINDOW}
              className="flex-1 h-12 rounded-xl bg-teal-600 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-md active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
              isDark ? "border-teal-900 bg-teal-950/50 text-teal-300" : "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            TEST 1
          </button>
        </div>
      </div>

      {/* 4. Connect Deriv Account & API Token Modal (Guaranteed Permission on iOS PWA) */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className={`w-full max-w-md rounded-xl border p-5 sm:p-6 space-y-5 shadow-2xl ${
            isDark ? "border-zinc-800 bg-zinc-950 text-white" : "border-slate-300 bg-white text-slate-900"
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? "border-zinc-900" : "border-slate-200"
            }`}>
              <div className="space-y-0.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Account Permission</span>
                <h3 className="text-sm font-bold uppercase tracking-wider">Connect Deriv Account</h3>
              </div>
              <button
                onClick={() => {
                  setShowConnectModal(false);
                  setTokenError(null);
                  setTokenSuccess(null);
                }}
                className="text-xs font-bold uppercase text-zinc-500 hover:text-white"
              >
                [X]
              </button>
            </div>

            {/* Option A: Direct API Token (Instant Permission, Guaranteed on iOS PWA) */}
            <form onSubmit={handleAuthorizeWithTokenSubmit} className="space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-teal-400">
                    Method 1: Deriv API Token (Recommended)
                  </span>
                  <a
                    href="https://app.deriv.com/account/api-token"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-teal-400 hover:underline"
                  >
                    Get Token ↗
                  </a>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Best for iOS PWA, mobile & desktop: In Deriv, go to <strong>Account Settings &gt; API Token</strong>, check <strong>Read</strong> and <strong>Trade</strong>, create a token, and paste it below:
                </p>
              </div>

              <input
                type="text"
                value={apiTokenInput}
                onChange={(e) => setApiTokenInput(e.target.value)}
                placeholder="Paste your Deriv API Token"
                className={`w-full rounded border px-3 py-2 text-xs font-mono outline-none ${
                  isDark ? "border-zinc-800 bg-black text-white focus:border-zinc-600" : "border-slate-300 bg-white text-slate-900 focus:border-slate-500"
                }`}
                required
              />

              {tokenError && (
                <p className="text-[11px] text-rose-400 leading-tight">
                  {tokenError}
                </p>
              )}

              {tokenSuccess && (
                <p className="text-[11px] text-teal-400 font-bold leading-tight">
                  {tokenSuccess}
                </p>
              )}

              <button
                type="submit"
                disabled={tokenBusy || !apiTokenInput.trim()}
                className="w-full rounded bg-teal-600 py-2.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors disabled:opacity-40 shadow-sm"
              >
                {tokenBusy ? "Authorizing Token with Deriv..." : "Authorize Account"}
              </button>
            </form>

            <div className="flex items-center gap-3">
              <div className={`h-px flex-1 ${isDark ? "bg-zinc-800" : "bg-slate-200"}`} />
              <span className="text-[10px] uppercase tracking-widest text-zinc-500">OR</span>
              <div className={`h-px flex-1 ${isDark ? "bg-zinc-800" : "bg-slate-200"}`} />
            </div>

            {/* Option B: Deriv Auth 2.0 PKCE */}
            <div className="space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                Method 2: Deriv Auth 2.0 (Browser OAuth)
              </span>
              <button
                type="button"
                onClick={handleDirectOAuth}
                className={`w-full rounded border py-2.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                  isDark ? "border-zinc-700 bg-zinc-900 text-white hover:bg-zinc-800" : "border-slate-300 bg-slate-100 text-slate-900 hover:bg-slate-200"
                }`}
              >
                Sign In with Deriv Auth 2.0
              </button>
              <p className="text-[10px] text-zinc-500 text-center leading-tight">
                Redirects to Deriv login. If using an installed iOS PWA, API Token (Method 1) is recommended.
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
                <span className="h-2 w-2 rounded-full bg-teal-400" />
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
                    ? isDark ? "border-teal-700 bg-teal-950/50 text-teal-300" : "border-teal-500 bg-teal-50 text-teal-800"
                    : isDark ? "border-zinc-800 bg-zinc-900 text-zinc-400" : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${notifsEnabled ? "bg-teal-400 animate-pulse" : "bg-zinc-600"}`} />
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
                className="w-full rounded bg-teal-600 py-3 text-xs font-bold uppercase tracking-wider text-white shadow-sm"
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
                isDark ? "border-teal-900 text-teal-400 bg-teal-950/20" : "border-teal-300 text-teal-800 bg-teal-50"
              }`}
            >
              CONNECT DERIV ACCOUNT / TOKEN
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
                className="text-teal-500 hover:text-teal-400 font-bold hover:underline"
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
                <div className={`text-2xl font-light ${isDark ? "text-white" : "text-slate-900"}`}>
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
              <li>Tap the <span className="font-semibold text-teal-400">Share</span> button in Safari's bottom toolbar.</li>
              <li>Scroll down and select <span className="font-semibold text-teal-400">Add to Home Screen</span>.</li>
              <li>Tap <span className="font-semibold text-teal-400">Add</span> in the top-right corner.</li>
            </ol>
            <button
              onClick={() => setShowIOSInstallGuide(false)}
              className="w-full rounded bg-teal-600 py-2.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors shadow-sm"
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
