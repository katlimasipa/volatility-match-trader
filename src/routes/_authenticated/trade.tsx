import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { session, getDerivClientId, setDerivClientId, derivRedirectUri } from "@/lib/deriv-config";
import {
  startDerivAuth,
  getStoredAccounts,
  storeAccounts,
  getActiveAccountId,
  setActiveAccountId,
  getActiveAccountType,
  getStoredAuthInfo,
  getManualToken,
  setManualToken,
  clearAllDerivAuth,
  type DerivAccount,
} from "@/lib/deriv-auth";
import { DerivWS } from "@/lib/deriv-ws";
import { analyze, lastDigit, shouldEnter, MAX_DIFF, MAX_RUNS, SYMBOL, WINDOW } from "@/lib/matches";

export const Route = createFileRoute("/_authenticated/trade")({
  head: () => ({
    meta: [
      { title: "Matches Terminal // Volatility 100" },
      { name: "description", content: "Deriv Matches trading bot for Volatility 100." },
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

function TradeTerminal() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);

  // Deriv connection & account state
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"demo" | "real">("demo");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [appIdInput, setAppIdInput] = useState("");
  const [manualTokenInput, setManualTokenInput] = useState("");

  // Market stream state
  const [digits, setDigits] = useState<number[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  // Bot configuration & execution state
  const [stake, setStake] = useState(1);
  const [tp, setTp] = useState(15);
  const [sl, setSl] = useState(5);
  const [running, setRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [botState, setBotState] = useState<"idle" | "analyzing" | "waiting_entry" | "in_trade" | "loss_reanalysis" | "completed">("idle");
  const [note, setNote] = useState("System idle. Configure stake and start bot.");

  const pending = useRef<PendingTrade | null>(null);
  const lossCooldownTicks = useRef(0);
  const wsRef = useRef<DerivWS | null>(null);

  // Sync ref with live state for WebSocket tick callback
  const stateRef = useRef({
    running,
    stake,
    tp,
    sl,
    runCount,
    trades,
    botState,
  });
  stateRef.current = { running, stake, tp, sl, runCount, trades, botState };

  // Check login session & initialize account states
  useEffect(() => {
    const userEmail = session.get();
    if (!userEmail) {
      navigate({ to: "/" });
      return;
    }
    setEmail(userEmail);

    const savedAccounts = getStoredAccounts();
    const storedActive = getActiveAccountId();
    const storedType = getActiveAccountType();

    if (savedAccounts.length > 0) {
      setAccounts(savedAccounts);
      setActiveId(storedActive || savedAccounts[0].account_id);
      setActiveType(storedType);
    } else {
      // Mock initial demo & real view if not connected yet
      const initialMock: DerivAccount[] = [
        { account_id: "VRTC_DEMO", account_type: "demo", currency: "USD", balance: "10000.00" },
        { account_id: "CR_REAL", account_type: "real", currency: "USD", balance: "0.00" },
      ];
      setAccounts(initialMock);
      setActiveId("VRTC_DEMO");
      setActiveType("demo");
    }

    setAppIdInput(getDerivClientId());
    setManualTokenInput(getManualToken());
  }, [navigate]);

  // Connect to Deriv WebSocket tick feed
  useEffect(() => {
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${getDerivClientId() || "1089"}`;
    const ws = new DerivWS(wsUrl, (s) => setStatus(s));
    wsRef.current = ws;

    // Listen for tick history and live ticks
    ws.registerHandler("history", (data) => {
      const history = data.history as { prices?: number[] };
      if (history?.prices) {
        const pList = history.prices;
        setDigits(pList.map((p) => lastDigit(p)));
        setPrice(pList[pList.length - 1] ?? null);
      }
    });

    ws.registerHandler("tick", (data) => {
      const tick = data.tick as { quote?: number };
      if (typeof tick?.quote === "number") {
        const q = tick.quote;
        setPrice((curr) => {
          setPrevPrice(curr);
          return q;
        });

        const nextDigit = lastDigit(q);
        setDigits((prev) => {
          const next = [...prev, nextDigit];
          if (next.length > WINDOW) next.shift();
          handleTickEvent(next, q, nextDigit);
          return next;
        });
      }
    });

    // Request 1000 ticks history and subscribe to live stream
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

  // Strategy Execution Engine
  function handleTickEvent(tickList: number[], currentPrice: number, currentD: number) {
    const s = stateRef.current;

    // 1. Settle in-flight contract on the tick immediately following entry
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
        return stopBot(`Cycle finished: ${MAX_RUNS} runs completed (Total: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)})`);
      }

      // If Loss: Require re-analysis of the market before allowing the next trade
      if (!won) {
        lossCooldownTicks.current = 5; // require at least 5 fresh ticks of re-analysis
        setBotState("loss_reanalysis");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Lost (${currentD} ≠ ${p.target}). Re-analyzing market distribution...`);
        return;
      } else {
        setBotState("analyzing");
        setNote(`Run ${p.runIndex}/${MAX_RUNS} Won (+${pnl.toFixed(2)} USD). Analyzing market for run ${nextRunCount + 1}...`);
        return;
      }
    }

    if (!s.running) return;

    // 2. Decrement loss cooldown ticks if re-analyzing
    if (s.botState === "loss_reanalysis") {
      if (lossCooldownTicks.current > 0) {
        lossCooldownTicks.current -= 1;
        setNote(`Loss re-analysis: streaming fresh ticks (${lossCooldownTicks.current} remaining)...`);
        return;
      }
    }

    // 3. Analyze current digit distribution
    const a = analyze(tickList);

    if (shouldEnter(a, currentD)) {
      // Entry condition met: spread <= 0.3% AND current digit matches most appearing digit
      const targetRun = s.runCount + 1;
      pending.current = {
        runIndex: targetRun,
        entry: currentD,
        target: a.second,
        stake: s.stake,
      };
      setBotState("in_trade");
      setNote(`Run ${targetRun}/${MAX_RUNS}: Entered on digit ${currentD}. Matching target ${a.second}...`);
    } else if (a.ok) {
      setBotState("waiting_entry");
      setNote(`Spread verified (Δ ${a.diff.toFixed(2)}% ≤ ${MAX_DIFF}%). Waiting for entry digit ${a.most}...`);
    } else {
      setBotState("analyzing");
      setNote(`Spread Δ ${a.diff.toFixed(2)}% > ${MAX_DIFF}%. Analyzing market ticks...`);
    }
  }

  function startBot() {
    setTrades([]);
    setRunCount(0);
    pending.current = null;
    lossCooldownTicks.current = 0;
    setRunning(true);
    setBotState("analyzing");
    setNote("Bot active. Evaluating Volatility 100 digit distribution...");
  }

  function stopBot(message: string) {
    setRunning(false);
    setBotState("idle");
    setNote(message);
    pending.current = null;
  }

  function switchAccount(type: "demo" | "real") {
    const acc = accounts.find((a) => a.account_type === type);
    if (acc) {
      setActiveId(acc.account_id);
      setActiveType(type);
      setActiveAccountId(acc.account_id);
    }
  }

  function handleSaveAppId() {
    setDerivClientId(appIdInput.trim());
    if (manualTokenInput.trim()) {
      setManualToken(manualTokenInput.trim());
    }
    setShowAuthModal(false);
  }

  async function handleTriggerOAuth() {
    const id = appIdInput.trim() || getDerivClientId();
    if (!id) {
      alert("Please enter your Deriv App ID first.");
      return;
    }
    setDerivClientId(id);
    try {
      await startDerivAuth({
        clientId: id,
        redirectUri: derivRedirectUri(),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to initiate Deriv Auth 2.0");
    }
  }

  const analysis = analyze(digits);
  const currentDigit = digits[digits.length - 1];
  const maxPercent = Math.max(...analysis.percents, 1);
  const totalPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;

  const demoAcc = accounts.find((a) => a.account_type === "demo");
  const realAcc = accounts.find((a) => a.account_type === "real");

  return (
    <main className="min-h-screen bg-black text-white font-mono selection:bg-white selection:text-black">
      {/* Top Bar */}
      <header className="border-b border-zinc-900 bg-zinc-950 px-6 py-3.5">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 bg-white" />
              <span className="text-sm font-semibold tracking-wider text-white">MATCHES // V100</span>
            </div>
            <div className="hidden items-center gap-2 border-l border-zinc-800 pl-4 text-xs text-zinc-400 sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${status === "live" ? "bg-white" : "bg-zinc-700 animate-pulse"}`} />
              <span className="uppercase">{status}</span>
            </div>
          </div>

          {/* Demo & Real Account Switcher with Live Balances */}
          <div className="flex items-center gap-3">
            <div className="flex items-center border border-zinc-800 bg-black text-xs">
              <button
                onClick={() => switchAccount("demo")}
                className={`flex items-center gap-2 px-3 py-1.5 transition-colors ${
                  activeType === "demo"
                    ? "bg-white text-black font-semibold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <span>DEMO</span>
                <span className="font-semibold num">
                  ${demoAcc?.balance ? Number(demoAcc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "10,000.00"}
                </span>
              </button>

              <button
                onClick={() => switchAccount("real")}
                className={`flex items-center gap-2 border-l border-zinc-800 px-3 py-1.5 transition-colors ${
                  activeType === "real"
                    ? "bg-white text-black font-semibold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <span>REAL</span>
                <span className="font-semibold num">
                  ${realAcc?.balance ? Number(realAcc.balance).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "0.00"}
                </span>
              </button>
            </div>

            {/* Deriv Auth Button */}
            <button
              onClick={() => setShowAuthModal(true)}
              className="border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors"
            >
              DERIV AUTH 2.0
            </button>

            {/* Sign Out */}
            <button
              onClick={() => {
                session.clear();
                clearAllDerivAuth();
                navigate({ to: "/" });
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              EXIT
            </button>
          </div>
        </div>
      </header>

      {/* Main Terminal Workspace */}
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        {/* Spot & Last Digit Hero */}
        <section className="grid gap-6 border border-zinc-900 bg-zinc-950 p-6 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              VOLATILITY 100 INDEX · SPOT PRICE
            </span>
            <div className="flex items-baseline gap-4">
              <span className="num text-5xl font-light tracking-tight text-white sm:text-6xl">
                {price !== null ? price.toFixed(2) : "—"}
              </span>
              {prevPrice !== null && price !== null && (
                <span className="text-sm font-normal text-zinc-400">
                  {price >= prevPrice ? "▲" : "▼"} {Math.abs(price - prevPrice).toFixed(2)}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col justify-between border-t border-zinc-900 pt-4 sm:border-t-0 sm:border-l sm:border-zinc-900 sm:pl-6 sm:pt-0">
            <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              CURRENT LAST DIGIT
            </span>
            <div className="num text-6xl font-light text-white">
              {currentDigit !== undefined ? currentDigit : "—"}
            </div>
            <span className="text-[11px] text-zinc-500">
              Pip Decimals: 2 · R_100
            </span>
          </div>
        </section>

        {/* Digit Frequency Matrix (0–9) & Spread Bar */}
        <section className="border border-zinc-900 bg-zinc-950 p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-900 pb-4">
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                DIGIT DISTRIBUTION MATRIX (0–9)
              </span>
              <div className="text-xs text-zinc-400">
                Window: {analysis.total} ticks · Target: Digits Matches Strategy
              </div>
            </div>

            {/* Spread Readout Badge */}
            <div className="flex items-center gap-3">
              <div className="border border-zinc-800 bg-black px-3 py-1.5 text-xs">
                <span className="text-zinc-500 mr-2">SPREAD:</span>
                <span className="font-semibold text-white num">
                  Δ {analysis.diff.toFixed(2)}%
                </span>
                <span className="text-zinc-600 mx-1.5">/</span>
                <span className="text-zinc-400">MAX {MAX_DIFF}%</span>
              </div>

              <div
                className={`border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider ${
                  analysis.ok
                    ? "border-white bg-white text-black"
                    : "border-zinc-800 bg-black text-zinc-600"
                }`}
              >
                {analysis.ok ? "Condition Met" : "Spread Too Wide"}
              </div>
            </div>
          </div>

          {/* Histogram Bars */}
          <div className="grid grid-cols-10 gap-2 pt-2">
            {analysis.percents.map((pct, d) => {
              const isMost = d === analysis.most;
              const isSecond = d === analysis.second;
              const isCurrent = d === currentDigit;
              const barHeight = (pct / maxPercent) * 100;

              return (
                <div key={d} className="flex flex-col items-center gap-2">
                  <div className="relative flex h-36 w-full items-end bg-black border border-zinc-900">
                    <div
                      className={`w-full transition-all duration-300 ${
                        isMost
                          ? "bg-white"
                          : isSecond
                          ? "bg-zinc-400"
                          : "bg-zinc-800"
                      }`}
                      style={{ height: `${Math.max(barHeight, 4)}%` }}
                    />
                    {isMost && (
                      <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[9px] font-bold text-black bg-white px-1">
                        ENTRY
                      </div>
                    )}
                    {isSecond && (
                      <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[9px] font-bold text-white bg-zinc-800 px-1">
                        MATCH
                      </div>
                    )}
                  </div>

                  <span
                    className={`text-base font-semibold num ${
                      isCurrent ? "text-white underline underline-offset-4" : "text-zinc-400"
                    }`}
                  >
                    {d}
                  </span>
                  <span className="text-[11px] text-zinc-500 num">
                    {pct.toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>

          {/* Strategic Digits Summary */}
          <div className="grid grid-cols-2 gap-4 border-t border-zinc-900 pt-4 sm:grid-cols-4">
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                1. Entry Digit (Most)
              </span>
              <div className="text-2xl font-light text-white num">
                {analysis.most}
              </div>
              <div className="text-[11px] text-zinc-400 num">
                {analysis.mostPct.toFixed(2)}% frequency
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                2. Target Digit (Second)
              </span>
              <div className="text-2xl font-light text-white num">
                {analysis.second}
              </div>
              <div className="text-[11px] text-zinc-400 num">
                {analysis.secondPct.toFixed(2)}% frequency
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                Cycle Runs Limit
              </span>
              <div className="text-2xl font-light text-white num">
                {runCount} / {MAX_RUNS}
              </div>
              <div className="text-[11px] text-zinc-400">
                {wins} Won · {runCount - wins} Lost
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                Cycle Profit / Loss
              </span>
              <div
                className={`text-2xl font-light num ${
                  totalPnl > 0 ? "text-white font-bold" : totalPnl < 0 ? "text-zinc-400" : "text-zinc-200"
                }`}
              >
                {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
              </div>
              <div className="text-[11px] text-zinc-500">
                Payout ~8.0x on Win
              </div>
            </div>
          </div>
        </section>

        {/* Bot Controls & Live Console */}
        <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* Execution History Ledger */}
          <div className="border border-zinc-900 bg-zinc-950 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                EXECUTION HISTORY LEDGER
              </span>
              <span className="text-xs text-zinc-500">
                Max 3 Runs / Cycle
              </span>
            </div>

            {trades.length === 0 ? (
              <div className="py-12 text-center text-xs text-zinc-600">
                No trades recorded in current cycle. Start bot to begin analysis and execution.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs num">
                  <thead>
                    <tr className="border-b border-zinc-900 text-zinc-500 uppercase tracking-wider">
                      <th className="py-2.5">Run</th>
                      <th>Time</th>
                      <th>Entry</th>
                      <th>Match Target</th>
                      <th>Exit Digit</th>
                      <th>Stake</th>
                      <th>Result</th>
                      <th className="text-right">P/L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {trades.map((t) => (
                      <tr key={t.id} className="text-zinc-300">
                        <td className="py-2.5 text-zinc-500">#{t.runIndex}</td>
                        <td className="text-zinc-500">{t.time}</td>
                        <td>{t.entry}</td>
                        <td>{t.target}</td>
                        <td className={t.result === t.target ? "text-white font-bold" : "text-zinc-400"}>
                          {t.result}
                        </td>
                        <td>${t.stake.toFixed(2)}</td>
                        <td>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              t.pnl > 0
                                ? "bg-white text-black"
                                : "border border-zinc-800 text-zinc-500"
                            }`}
                          >
                            {t.pnl > 0 ? "WIN" : "LOSS"}
                          </span>
                        </td>
                        <td className={`text-right font-semibold ${t.pnl > 0 ? "text-white" : "text-zinc-500"}`}>
                          {t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Bot Configuration Panel */}
          <div className="border border-zinc-900 bg-zinc-950 p-6 space-y-6">
            <div className="border-b border-zinc-900 pb-3">
              <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                BOT PARAMETERS
              </span>
            </div>

            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Stake Amount (USD)
                </span>
                <input
                  type="number"
                  min={0.35}
                  step={0.5}
                  disabled={running}
                  value={stake}
                  onChange={(e) => setStake(Math.max(0.35, Number(e.target.value)))}
                  className="w-full border border-zinc-800 bg-black px-3.5 py-2 font-mono text-lg text-white num outline-none focus:border-white disabled:opacity-50"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Take Profit (USD)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={running}
                  value={tp}
                  onChange={(e) => setTp(Math.max(1, Number(e.target.value)))}
                  className="w-full border border-zinc-800 bg-black px-3.5 py-2 font-mono text-lg text-white num outline-none focus:border-white disabled:opacity-50"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-[11px] uppercase tracking-wider text-zinc-400">
                  Stop Loss (USD)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  disabled={running}
                  value={sl}
                  onChange={(e) => setSl(Math.max(1, Number(e.target.value)))}
                  className="w-full border border-zinc-800 bg-black px-3.5 py-2 font-mono text-lg text-white num outline-none focus:border-white disabled:opacity-50"
                />
              </label>
            </div>

            {/* Bot Controls */}
            <div className="space-y-3 pt-2">
              {running ? (
                <button
                  onClick={() => stopBot("User manually stopped bot.")}
                  className="w-full border border-zinc-600 bg-black py-3 font-mono text-xs uppercase tracking-[0.2em] text-white hover:border-white transition-colors"
                >
                  HALT BOT
                </button>
              ) : (
                <button
                  onClick={startBot}
                  disabled={status !== "live" || stake <= 0}
                  className="w-full border border-white bg-white py-3 font-mono text-xs uppercase tracking-[0.2em] text-black hover:bg-zinc-200 transition-colors disabled:opacity-40"
                >
                  START BOT (3 RUNS)
                </button>
              )}

              {/* Bot State Banner */}
              <div className="border border-zinc-900 bg-black p-3 space-y-1">
                <div className="flex items-center justify-between text-[10px] uppercase text-zinc-500">
                  <span>STATE</span>
                  <span className="text-white">{botState}</span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  {note}
                </p>
              </div>
            </div>

            <div className="border-t border-zinc-900 pt-4 text-[11px] leading-relaxed text-zinc-500">
              Contract: Matches (DIGITMATCH) · Duration: 1 Tick · Symbol: Volatility 100 Index.
            </div>
          </div>
        </section>
      </div>

      {/* Deriv Auth 2.0 Settings & Permissions Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-xs">
          <div className="w-full max-w-lg border border-zinc-800 bg-zinc-950 p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <div>
                <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  DERIV API SETTINGS
                </span>
                <h3 className="text-lg font-semibold text-white">Deriv Auth 2.0 Integration</h3>
              </div>
              <button
                onClick={() => setShowAuthModal(false)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <label className="block space-y-1">
                <span className="text-zinc-400 uppercase tracking-wider">Deriv App ID</span>
                <input
                  type="text"
                  placeholder="e.g. 1089 or your registered App ID"
                  value={appIdInput}
                  onChange={(e) => setAppIdInput(e.target.value)}
                  className="w-full border border-zinc-800 bg-black px-3 py-2 text-white outline-none focus:border-white"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-zinc-400 uppercase tracking-wider">Manual API Token (Optional Fallback)</span>
                <input
                  type="password"
                  placeholder="Paste Deriv API token for direct connection"
                  value={manualTokenInput}
                  onChange={(e) => setManualTokenInput(e.target.value)}
                  className="w-full border border-zinc-800 bg-black px-3 py-2 text-white outline-none focus:border-white"
                />
              </label>

              <div className="border border-zinc-900 bg-black p-3 space-y-2">
                <span className="font-semibold text-white uppercase tracking-wider text-[11px]">
                  Registered Redirect URI:
                </span>
                <div className="text-zinc-400 select-all font-mono break-all">
                  {derivRedirectUri()}
                </div>
              </div>

              {/* Required Permissions Guide */}
              <div className="border border-zinc-900 bg-black p-3 space-y-2">
                <span className="font-semibold text-white uppercase tracking-wider text-[11px]">
                  App ID Permissions (Scopes Required):
                </span>
                <ul className="space-y-1 text-zinc-400">
                  <li>• <strong className="text-white">Read (read):</strong> Access account IDs and live balances.</li>
                  <li>• <strong className="text-white">Trade (trade):</strong> Open Volatility 100 Matches contracts.</li>
                  <li>• <strong className="text-white">Trading Information (trading_information):</strong> Track trade results.</li>
                  <li className="text-zinc-600">• Do NOT select Payments or Admin.</li>
                </ul>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={handleTriggerOAuth}
                className="flex-1 border border-white bg-white py-2.5 font-mono text-xs uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors"
              >
                Sign in with Deriv Auth 2.0
              </button>
              <button
                onClick={handleSaveAppId}
                className="border border-zinc-700 bg-zinc-900 px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-white hover:border-white transition-colors"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
