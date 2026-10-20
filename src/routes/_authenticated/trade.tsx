import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { session, getDerivClientId, derivRedirectUri, DERIV_WS_URL } from "@/lib/deriv-config";
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
  type DerivAccount,
} from "@/lib/deriv-auth";
import { DerivWS } from "@/lib/deriv-ws";
import { analyze, lastDigit, shouldEnter, MAX_DIFF, MAX_RUNS, SYMBOL, WINDOW } from "@/lib/matches";

export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({
    meta: [
      { title: "ThDpstSmrtTrdr - Matches Strategy" },
      { name: "description", content: "Deriv Matches smart trader bot for Volatility 100." },
    ],
  }),
  component: TradeTerminal,
});

const WIN_MULTIPLIER = 8.0;

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

  // Deriv connection & account state
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"demo" | "real">("real");
  const [isConnectedToDeriv, setIsConnectedToDeriv] = useState(false);

  // Market stream state: strictly chronological ticks and digits
  const [digits, setDigits] = useState<number[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [recentTicks, setRecentTicks] = useState<TickItem[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  // Strategy & Bot configuration
  const [reAnalyzeOnLoss, setReAnalyzeOnLoss] = useState(true);
  const [repetitions] = useState(3); // 3 runs per user spec
  const [stake, setStake] = useState(1);
  const [riskTab, setRiskTab] = useState<"pnl" | "count">("pnl");
  const [tp, setTp] = useState(15);
  const [sl, setSl] = useState(5);
  const [centerTab, setCenterTab] = useState<"trade_log" | "session_history">("trade_log");

  // Execution state
  const [running, setRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [botState, setBotState] = useState<"Idle" | "Analyzing" | "Waiting Entry" | "In Trade" | "Loss Re-analysis" | "Completed">("Idle");
  const [note, setNote] = useState("System idle. Configure stake and click Start Bot.");

  // Backtest / Inspection Modal
  const [backtest, setBacktest] = useState<BacktestSummary | null>(null);
  const [showBacktestModal, setShowBacktestModal] = useState(false);

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
  });
  stateRef.current = { running, stake, tp, sl, runCount, trades, botState, reAnalyzeOnLoss, activeId };

  // Refresh live balances from Deriv API if logged in
  const refreshDerivBalances = useCallback(async () => {
    const authInfo = getStoredAuthInfo();
    if (authInfo?.access_token) {
      try {
        const fresh = await fetchDerivAccounts(authInfo, HARDCODED_APP_ID);
        if (fresh && fresh.length > 0) {
          setAccounts(fresh);
        }
      } catch {
        // Keep current balances
      }
    }
  }, []);

  // Check login session & accounts
  useEffect(() => {
    handleIncomingOAuth().then((res) => {
      if (res.handled && res.success) {
        const saved = getStoredAccounts();
        if (saved.length > 0) {
          setAccounts(saved);
          setIsConnectedToDeriv(true);
        }
      }
    });

    const userEmail = session.get();
    if (!userEmail) {
      navigate({ to: "/" });
      return;
    }
    setEmail(userEmail);

    const savedAccounts = getStoredAccounts();
    const storedActive = getActiveAccountId();
    const storedType = getActiveAccountType();
    const authInfo = getStoredAuthInfo();

    if (savedAccounts.length > 0) {
      setAccounts(savedAccounts);
      setActiveId(storedActive || savedAccounts[0].account_id);
      setActiveType(storedType);
      setIsConnectedToDeriv(Boolean(authInfo));
    } else {
      const initialMock: DerivAccount[] = [
        { account_id: "ROT91945350", account_type: "real", currency: "USD", balance: "0.00" },
        { account_id: "VRTC1029384", account_type: "demo", currency: "USD", balance: "10000.00" },
      ];
      storeAccounts(initialMock);
      setAccounts(initialMock);
      setActiveId("ROT91945350");
      setActiveType("real");
      setIsConnectedToDeriv(false);
    }

    refreshDerivBalances();
    const balanceInterval = setInterval(refreshDerivBalances, 8000);
    window.addEventListener("focus", refreshDerivBalances);

    return () => {
      clearInterval(balanceInterval);
      window.removeEventListener("focus", refreshDerivBalances);
    };
  }, [navigate, refreshDerivBalances]);

  // Connect to Deriv WebSocket tick feed & balance stream
  useEffect(() => {
    const ws = new DerivWS(DERIV_WS_URL, (s) => setStatus(s));
    wsRef.current = ws;

    // Listen for balance updates from Deriv
    ws.registerHandler("balance", (data) => {
      const bData = data.balance as {
        accounts?: Record<string, { balance: number; currency: string }>;
        balance?: number;
        loginid?: string;
      };
      if (bData?.accounts) {
        setAccounts((prev) => {
          const updated = prev.map((acc) => {
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
        setNote(
          `1,000 ticks analyzed: Most [${a.most}] (${a.mostPct.toFixed(1)}%), Target [${a.second}] (${a.secondPct.toFixed(1)}%), Spread Δ ${a.diff.toFixed(2)}%. Ready to run.`
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
        setDigits((prev) => {
          const next = [...prev, nextDigit];
          if (next.length > WINDOW) next.shift();
          handleTickEvent(next, q, nextDigit);
          return next;
        });
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

  function handleTickEvent(tickList: number[], _currentPrice: number, currentD: number) {
    const s = stateRef.current;

    // 1. Settle in-flight trade on the tick following entry
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      const won = currentD === p.target;
      const pnl = won ? p.stake * WIN_MULTIPLIER : -p.stake;

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
        const updated = prev.map((acc) => {
          if (acc.account_id === s.activeId) {
            const currentBal = parseFloat(acc.balance) || 0;
            const nextBal = Math.max(0, currentBal + pnl);
            return { ...acc, balance: nextBal.toFixed(2) };
          }
          return acc;
        });
        storeAccounts(updated);
        return updated;
      });

      // Background sync with Deriv if connected
      refreshDerivBalances();

      const totalPnl = updatedTrades.reduce((acc, t) => acc + t.pnl, 0);
      const nextRunCount = s.runCount + 1;
      setRunCount(nextRunCount);

      // Check Risk Limits
      if (totalPnl >= s.tp) {
        return stopBot(`Take Profit reached (+$${totalPnl.toFixed(2)})`);
      }
      if (totalPnl <= -s.sl) {
        return stopBot(`Stop Loss reached (-$${Math.abs(totalPnl).toFixed(2)})`);
      }
      if (nextRunCount >= MAX_RUNS) {
        return stopBot(`Cycle completed: ${MAX_RUNS} runs finished (Total: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)})`);
      }

      // Re-analysis rule on loss
      if (!won && s.reAnalyzeOnLoss) {
        lossCooldownTicks.current = 5;
        setBotState("Loss Re-analysis");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Lost (${currentD} ≠ ${p.target}). Re-analyzing market distribution...`);
        return;
      } else {
        setBotState("Analyzing");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Won (+${pnl.toFixed(2)} USD). Analyzing market for run ${nextRunCount + 1}...`);
        return;
      }
    }

    if (!s.running) return;

    if (s.botState === "Loss Re-analysis") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setNote(`Loss re-analysis: streaming fresh ticks (${lossCooldownTicks.current} remaining)...`);
        return;
      }
    }

    const a = analyze(tickList);

    if (shouldEnter(a, currentD)) {
      const targetRun = s.runCount + 1;
      pending.current = {
        runIndex: targetRun,
        entry: currentD,
        target: a.second,
        stake: s.stake,
      };
      setBotState("In Trade");
      setNote(`Run ${targetRun}/${MAX_RUNS}: Entered on digit ${currentD}. Matching target ${a.second}...`);
    } else if (a.ok) {
      setBotState("Waiting Entry");
      setNote(`Spread verified (Δ ${a.diff.toFixed(2)}% ≤ ${MAX_DIFF}%). Waiting for entry digit ${a.most}...`);
    } else {
      setBotState("Analyzing");
      setNote(`Spread Δ ${a.diff.toFixed(2)}% > ${MAX_DIFF}%. Analyzing market ticks...`);
    }
  }

  function startBot() {
    if (digits.length === 0) {
      setNote("Buffering market ticks. Please wait a moment before starting...");
      return;
    }
    setTrades([]);
    setRunCount(0);
    pending.current = null;
    lossCooldownTicks.current = 0;
    setRunning(true);
    setBotState("Analyzing");
    setNote("Bot active. Evaluating Volatility 100 digit distribution for Run 1...");
  }

  function stopBot(message: string) {
    setRunning(false);
    setBotState("Idle");
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
    if (digits.length < 100) {
      alert("Buffering ticks. Need at least 100 ticks to calculate backtest.");
      return;
    }

    let signals = 0;
    let wins = 0;
    let losses = 0;
    let pnl = 0;
    const windowSize = Math.min(200, Math.floor(digits.length / 2));

    for (let i = windowSize; i < digits.length - 1; i++) {
      const slice = digits.slice(i - windowSize, i);
      const a = analyze(slice);
      const entryDigit = digits[i];

      if (shouldEnter(a, entryDigit)) {
        signals++;
        const nextDigit = digits[i + 1];
        if (nextDigit === a.second) {
          wins++;
          pnl += stake * WIN_MULTIPLIER;
        } else {
          losses++;
          pnl -= stake;
        }
      }
    }

    const winRate = signals > 0 ? (wins / signals) * 100 : 0;
    setBacktest({
      totalTicks: digits.length,
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
      setActiveType(acc.account_type);
      setActiveAccountId(acc.account_id);
      refreshDerivBalances();
    }
  }

  function toggleDemoReal() {
    const targetType = activeType === "real" ? "demo" : "real";
    const targetAcc = accounts.find((a) => a.account_type === targetType);
    if (targetAcc) {
      switchAccount(targetAcc.account_id);
    }
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

  const analysis = analyze(digits);
  const currentDigit = digits[digits.length - 1];
  const totalPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0;

  const activeAccount = accounts.find((a) => a.account_id === activeId) || accounts[0];

  // Strictly chronological sequence of the latest 33 digits (incoming order from left to right)
  const recentDigits33 = digits.slice(-33);

  return (
    <div className="min-h-screen bg-black text-white font-mono antialiased selection:bg-white selection:text-black">
      {/* 1. Header Bar: Sleek Dark Terminal Aesthetic */}
      <header className="border-b border-zinc-900 bg-zinc-950 px-6 py-3.5">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-4">
          {/* Logo & Sub-status */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2.5">
              <span className="flex h-3 w-3 items-center justify-center rounded-full bg-teal-500 ring-4 ring-teal-950">
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <span className="text-base font-bold tracking-tight text-white">
                ThDpstSmrtTrdr <span className="font-normal text-zinc-500">- Matches Strategy</span>
              </span>
            </div>

            <div className="hidden sm:flex items-center gap-3 border-l border-zinc-800 pl-6 text-xs">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${running ? "bg-teal-400 animate-pulse" : "bg-amber-400"}`} />
                <span className="font-medium text-zinc-400 uppercase">{botState}</span>
              </div>
              <span className="text-zinc-800">|</span>
              <div className="flex items-center gap-1">
                <span className="text-zinc-500">NET P/L</span>
                <span className={`font-semibold num ${totalPnl >= 0 ? "text-white" : "text-zinc-400"}`}>
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
                </span>
              </div>
              <span className="text-zinc-800">|</span>
              <div className="flex items-center gap-1">
                <span className="text-zinc-500">TRADES</span>
                <span className="font-semibold text-zinc-200 num">{trades.length}</span>
              </div>
            </div>
          </div>

          {/* Right Header Controls */}
          <div className="flex items-center gap-3.5">
            {/* Live Auto-updating Balance */}
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-zinc-500">{activeAccount?.currency || "USD"}</span>
              <span className="font-bold text-white num">
                {activeAccount?.balance ? Number(activeAccount.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "0.00"}
              </span>
            </div>

            {/* Account Switcher Dropdown with Auto-updating Balances */}
            <select
              value={activeId || ""}
              onChange={(e) => switchAccount(e.target.value)}
              className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 outline-none hover:border-zinc-700 transition-colors"
            >
              {accounts.map((acc) => (
                <option key={acc.account_id} value={acc.account_id} className="bg-zinc-900 text-white">
                  {acc.account_id} ({acc.account_type === "real" ? "Real" : "Demo"}) — ${Number(acc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </option>
              ))}
            </select>

            {/* Log Out Button */}
            <button
              onClick={() => {
                session.clear();
                clearAllDerivAuth();
                navigate({ to: "/" });
              }}
              className="flex items-center gap-1.5 rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-700 hover:text-white transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span>Log out</span>
            </button>

            {/* Action Buttons: Teal Start Bot button */}
            <div className="flex items-center gap-2 pl-2 border-l border-zinc-800">
              {running ? (
                <button
                  onClick={() => stopBot("User stopped bot.")}
                  className="rounded bg-rose-600 px-5 py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-rose-500 transition-colors shadow-sm"
                >
                  Stop Bot
                </button>
              ) : (
                <button
                  onClick={startBot}
                  disabled={digits.length === 0}
                  className="rounded bg-teal-600 px-5 py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-teal-500 transition-colors shadow-sm disabled:opacity-40"
                >
                  Start Bot
                </button>
              )}

              <button
                onClick={resetSession}
                className="rounded border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
              >
                Reset
              </button>

              <button
                onClick={runBacktest1000Ticks}
                title="Test and calculate performance on last 1,000 ticks"
                className="rounded border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
              >
                End & Save
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 2. Main 3-Column Layout Matching Screenshot */}
      <main className="mx-auto max-w-[1560px] p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[290px_1fr_290px] gap-6 items-start">

          {/* LEFT COLUMN: Controls & Settings */}
          <aside className="space-y-6">
            {/* CONNECTION */}
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4 space-y-3 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  CONNECTION
                </span>
                {activeType === "demo" && (
                  <button
                    onClick={resetDemoBalance}
                    title="Reset demo virtual funds back to $10,000"
                    className="text-[10px] text-teal-400 hover:underline"
                  >
                    Reset $10k
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Active Account</label>
                {/* Clickable Card to switch Demo / Real */}
                <div
                  onClick={toggleDemoReal}
                  title="Click to toggle Real / Demo"
                  className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                    activeType === "real"
                      ? "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                      : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-white">
                      {activeAccount?.account_id} — {activeType === "real" ? "Real" : "Demo"}
                    </span>
                    <span className="font-bold text-white num">
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
                <div className="flex gap-2">
                  <button
                    disabled
                    className="flex-1 rounded border border-zinc-800 bg-zinc-900 py-2 text-xs font-medium text-zinc-400"
                  >
                    ✓ Connected
                  </button>
                  <button
                    onClick={refreshDerivBalances}
                    title="Sync latest balances from Deriv"
                    className="rounded border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-700 hover:text-white transition-colors"
                  >
                    🔄
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleDirectOAuth}
                  className="w-full rounded bg-teal-600 py-2 text-xs font-semibold text-white hover:bg-teal-500 transition-colors"
                >
                  Connect Deriv Auth 2.0
                </button>
              )}
            </section>

            {/* STRATEGY */}
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4 space-y-4 shadow-sm">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                STRATEGY
              </span>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Mode</label>
                <div className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold text-white flex items-center justify-between">
                  <span>Matches (Spread ≤ 0.3%)</span>
                  <span className="text-zinc-500 text-[10px]">▼</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Trades when most appearing digit matches entry and spread ≤ 0.3%.
                </p>
              </div>

              {/* Wait for failed cycle / Loss Re-analysis */}
              <div className="rounded-lg border border-zinc-900 bg-black p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-300">
                    Wait for a failed cycle
                  </span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-400">
                    ALL
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reAnalyzeOnLoss}
                    onChange={(e) => setReAnalyzeOnLoss(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-teal-600 focus:ring-teal-500"
                  />
                  <span className="text-xs font-medium text-zinc-300">
                    Re-analyze after loss
                  </span>
                </label>
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Skips immediate trade on a loss; buffers fresh ticks and re-analyzes market distribution before entering.
                </p>
              </div>

              {/* Repetitions & Stake */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-400">Repetitions</label>
                  <input
                    type="number"
                    disabled
                    value={repetitions}
                    className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-300 num outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-400">Stake (USD)</label>
                  <input
                    type="number"
                    min={0.35}
                    step={0.5}
                    disabled={running}
                    value={stake}
                    onChange={(e) => setStake(Math.max(0.35, Number(e.target.value)))}
                    className="w-full rounded border border-zinc-800 bg-black px-3 py-2 text-sm font-semibold text-white num outline-none focus:border-zinc-600"
                  />
                </div>
              </div>

              {/* Stake Quick Percentages based on Auto-updating Balance */}
              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={running}
                    onClick={() => {
                      const bal = activeAccount ? Number(activeAccount.balance) || 100 : 100;
                      const calculated = Math.max(0.35, Math.round((bal * (pct / 100)) * 100) / 100);
                      setStake(calculated);
                    }}
                    className="rounded border border-zinc-800 bg-zinc-900 py-1 text-[10px] font-semibold text-zinc-400 hover:border-zinc-700 hover:text-white transition-colors"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </section>

            {/* RISK */}
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4 space-y-3 shadow-sm">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                RISK
              </span>

              {/* Tabs */}
              <div className="flex rounded border border-zinc-800 p-0.5 bg-black">
                <button
                  type="button"
                  onClick={() => setRiskTab("pnl")}
                  className={`flex-1 rounded py-1.5 text-xs font-semibold transition-colors ${
                    riskTab === "pnl"
                      ? "bg-zinc-800 text-white shadow-sm"
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
                      ? "bg-zinc-800 text-white shadow-sm"
                      : "text-zinc-500 hover:text-white"
                  }`}
                >
                  Trade count
                </button>
              </div>

              {riskTab === "pnl" ? (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Take Profit ($)</label>
                    <input
                      type="number"
                      min={1}
                      disabled={running}
                      value={tp}
                      onChange={(e) => setTp(Math.max(1, Number(e.target.value)))}
                      className="w-full rounded border border-zinc-800 bg-black px-3 py-1.5 text-xs font-semibold text-white num outline-none focus:border-zinc-600"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400">Stop Loss ($)</label>
                    <input
                      type="number"
                      min={1}
                      disabled={running}
                      value={sl}
                      onChange={(e) => setSl(Math.max(1, Number(e.target.value)))}
                      className="w-full rounded border border-zinc-800 bg-black px-3 py-1.5 text-xs font-semibold text-white num outline-none focus:border-zinc-600"
                    />
                  </div>
                </div>
              ) : (
                <div className="py-2 text-xs text-zinc-400">
                  Cycle Trade Limit: <span className="font-bold text-white num">3 runs per cycle</span>
                </div>
              )}
            </section>
          </aside>

          {/* CENTER COLUMN: Last Digit, Tick Stream & Trade Log */}
          <main className="space-y-6">
            {/* Top Row: Last Digit & Tick Stream Side by Side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* CARD 1: LAST DIGIT */}
              <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-5 shadow-sm space-y-4">
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
                    <div className="text-sm font-bold text-white num">
                      {price !== null ? price.toFixed(2) : "—"}
                    </div>
                    <div className="text-[11px] font-semibold text-zinc-400 num">
                      SPREAD Δ {analysis.diff.toFixed(2)}% <span className="text-zinc-600">/ {MAX_DIFF}%</span>
                    </div>
                  </div>
                </div>

                {/* Giant Digit Display */}
                <div className="flex items-baseline gap-4">
                  <span className="text-7xl font-light tracking-tight text-white num">
                    {currentDigit !== undefined ? currentDigit : "—"}
                  </span>
                  <div className="space-y-0.5 text-xs">
                    <div className="text-zinc-400">
                      ENTRY DIGIT: <span className="font-bold text-white num">{analysis.most}</span> ({analysis.mostPct.toFixed(1)}%)
                    </div>
                    <div className="text-zinc-400">
                      MATCH TARGET: <span className="font-bold text-white num">{analysis.second}</span> ({analysis.secondPct.toFixed(1)}%)
                    </div>
                  </div>
                </div>

                {/* Chronological Digit Tiles: strictly showing numbers as they arrive from Deriv */}
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase text-zinc-500 pb-1">
                    <span>Live Sequence (Chronological)</span>
                    <span className="text-zinc-400">Latest &rarr;</span>
                  </div>

                  <div className="grid grid-cols-11 gap-1.5 text-center text-xs num">
                    {recentDigits33.slice(0, 11).map((d, i) => (
                      <span
                        key={i}
                        className="rounded border border-zinc-800 bg-zinc-900 py-1.5 text-zinc-300 font-semibold"
                      >
                        {d}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-11 gap-1.5 text-center text-xs num">
                    {recentDigits33.slice(11, 22).map((d, i) => (
                      <span
                        key={i + 11}
                        className="rounded border border-zinc-800 bg-zinc-900 py-1.5 text-zinc-300 font-semibold"
                      >
                        {d}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-11 gap-1.5 text-center text-xs num">
                    {recentDigits33.slice(22, 33).map((d, i) => {
                      const isLatest = i + 22 === recentDigits33.length - 1;
                      return (
                        <span
                          key={i + 22}
                          className={`rounded border py-1.5 font-semibold transition-all ${
                            isLatest
                              ? "border-white bg-white text-black font-bold ring-2 ring-zinc-700"
                              : "border-zinc-800 bg-zinc-900 text-zinc-300"
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
              <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-5 shadow-sm space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    TICK STREAM
                  </span>
                  <span className="text-[10px] text-zinc-500 num">
                    {digits.length} / {WINDOW} ticks
                  </span>
                </div>

                <div className="overflow-hidden text-xs num">
                  <table className="w-full text-left">
                    <tbody className="divide-y divide-zinc-900">
                      {recentTicks.slice(0, 13).map((tick, idx) => (
                        <tr key={idx} className="hover:bg-zinc-900/50">
                          <td className="py-1 text-zinc-500 text-[11px]">
                            {tick.time}
                          </td>
                          <td className="py-1 font-medium text-zinc-300">
                            {tick.price.toFixed(2)}
                          </td>
                          <td className="py-1 text-right font-bold">
                            <span className={`inline-block px-1.5 py-0.2 rounded text-[11px] ${
                              idx === 0
                                ? "bg-white text-black font-bold"
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
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 shadow-sm">
              <div className="flex items-center justify-between border-b border-zinc-900 px-5 py-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCenterTab("trade_log")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "trade_log"
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    TRADE LOG
                  </button>
                  <button
                    onClick={() => setCenterTab("session_history")}
                    className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                      centerTab === "session_history"
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-500 hover:text-white"
                    }`}
                  >
                    SESSION HISTORY
                  </button>
                </div>
                <span className="text-xs text-zinc-500 num">
                  {trades.length} trades
                </span>
              </div>

              <div className="p-6">
                {trades.length === 0 ? (
                  <div className="py-16 text-center space-y-3">
                    <div className="flex justify-center text-zinc-700">
                      <svg className="h-10 w-10 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <p className="text-xs text-zinc-600">
                      Trades will appear here once the bot fires.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto text-xs num">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-zinc-900 text-zinc-500 pb-2 uppercase text-[10px]">
                          <th className="py-2">Run</th>
                          <th>Time</th>
                          <th>Entry</th>
                          <th>Match Target</th>
                          <th>Exit Digit</th>
                          <th>Stake</th>
                          <th>Status</th>
                          <th className="text-right">P/L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-900">
                        {trades.map((t) => (
                          <tr key={t.id} className="hover:bg-zinc-900/40">
                            <td className="py-2.5 font-bold text-white">#{t.runIndex}</td>
                            <td className="text-zinc-500">{t.time}</td>
                            <td>{t.entry}</td>
                            <td className="font-semibold text-white">{t.target}</td>
                            <td className="font-bold text-white">{t.result}</td>
                            <td>${t.stake.toFixed(2)}</td>
                            <td>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                t.pnl > 0
                                  ? "bg-white text-black"
                                  : "border border-zinc-800 text-zinc-400"
                              }`}>
                                {t.pnl > 0 ? "WON" : "LOST"}
                              </span>
                            </td>
                            <td className={`text-right font-bold ${
                              t.pnl > 0 ? "text-white" : "text-zinc-500"
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
          </main>

          {/* RIGHT COLUMN: Session & Bot Overview */}
          <aside className="space-y-6">
            {/* SESSION */}
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4 space-y-4 shadow-sm">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                SESSION
              </span>

              {/* Net P/L Hero Card */}
              <div className="rounded-xl border border-zinc-800 bg-black p-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-zinc-400">NET P/L</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    totalPnl >= 0 ? "bg-zinc-800 text-white" : "border border-zinc-800 text-zinc-400"
                  }`}>
                    {totalPnl >= 0 ? "PROFIT" : "LOSS"}
                  </span>
                </div>
                <div className="text-3xl font-light tracking-tight text-white num">
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} <span className="text-xs font-normal text-zinc-500">USD</span>
                </div>
              </div>

              {/* 2x2 Stats Grid */}
              <div className="grid grid-cols-2 gap-3 num">
                <div className="rounded-lg border border-zinc-900 bg-black p-3">
                  <span className="text-[10px] font-semibold text-zinc-500">WINS</span>
                  <div className="text-2xl font-light text-white mt-1">{wins}</div>
                </div>

                <div className="rounded-lg border border-zinc-900 bg-black p-3">
                  <span className="text-[10px] font-semibold text-zinc-500">LOSSES</span>
                  <div className="text-2xl font-light text-zinc-400 mt-1">{losses}</div>
                </div>

                <div className="rounded-lg border border-zinc-900 bg-black p-3">
                  <span className="text-[10px] font-semibold text-zinc-500">TRADES</span>
                  <div className="text-2xl font-light text-white mt-1">{trades.length}</div>
                </div>

                <div className="rounded-lg border border-zinc-900 bg-black p-3">
                  <span className="text-[10px] font-semibold text-zinc-500">WIN RATE</span>
                  <div className="text-2xl font-light text-white mt-1">{winRate}%</div>
                </div>
              </div>
            </section>

            {/* BOT */}
            <section className="rounded-xl border border-zinc-900 bg-zinc-950 p-4 space-y-3.5 shadow-sm text-xs num">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                BOT
              </span>

              <div className="grid grid-cols-2 gap-y-3 gap-x-2">
                <div>
                  <div className="text-[10px] text-zinc-500">Status</div>
                  <div className="font-semibold text-white">{botState}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Pending</div>
                  <div className="font-semibold text-white">{pending.current ? "yes" : "no"}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Mode</div>
                  <div className="font-semibold text-white">Matches</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Cycle Limit</div>
                  <div className="font-semibold text-white">{MAX_RUNS} runs</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Reps (Digit {analysis.most})</div>
                  <div className="font-semibold text-white">{runCount} / {MAX_RUNS}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Symbol</div>
                  <div className="font-semibold text-white">{SYMBOL}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Duration</div>
                  <div className="font-semibold text-white">1 tick</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Feed Status</div>
                  <div className="font-semibold text-white uppercase">{status}</div>
                </div>
              </div>

              {/* Bot Status Note */}
              <div className="rounded-lg border border-zinc-900 bg-black p-2.5 mt-2 text-[11px] leading-relaxed text-zinc-400">
                {note}
              </div>
            </section>
          </aside>
        </div>
      </main>

      {/* Backtest / Test Results Modal */}
      {showBacktestModal && backtest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                1,000 TICKS BACKTEST RESULTS
              </span>
              <button
                onClick={() => setShowBacktestModal(false)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Calculated across the latest {backtest.totalTicks} real market ticks of Volatility 100 Index using the Deriv Matches strategy (spread ≤ 0.3%, enter on most appearing digit, target second most appearing digit):
            </p>

            <div className="grid grid-cols-2 gap-4 rounded border border-zinc-900 bg-black p-4 num">
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Signals Found</span>
                <div className="text-2xl font-light text-white">{backtest.signals}</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Win Rate</span>
                <div className="text-2xl font-light text-white">{backtest.winRate.toFixed(1)}%</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Wins / Losses</span>
                <div className="text-2xl font-light text-white">{backtest.wins}W · {backtest.losses}L</div>
              </div>
              <div>
                <span className="text-[10px] uppercase text-zinc-500">Simulated Net P/L</span>
                <div className="text-2xl font-light text-white">
                  {backtest.netPnl >= 0 ? "+" : ""}${backtest.netPnl.toFixed(2)}
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowBacktestModal(false)}
              className="w-full rounded border border-white bg-white py-2.5 text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors shadow-sm"
            >
              Close Test Results
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export default TradeTerminal;
