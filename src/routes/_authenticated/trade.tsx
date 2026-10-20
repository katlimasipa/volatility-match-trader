import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DERIV_WS_URL, session } from "@/lib/deriv-config";
import { analyze, lastDigit, shouldEnter, MAX_DIFF, MAX_RUNS, SYMBOL, WINDOW } from "@/lib/matches";

export const Route = createFileRoute("/trade")({
  head: () => ({
    meta: [
      { title: "Matches — Volatility 100 Trader" },
      { name: "description", content: "Digit analysis and Matches bot for Volatility 100." },
      { property: "og:title", content: "Matches — Volatility 100 Trader" },
      { property: "og:description", content: "Digit analysis and Matches bot for Volatility 100." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Trade,
});

// Simulated profit on a winning Matches contract (Deriv pays roughly 8x stake as profit on 1-tick Matches).
const WIN_MULTIPLIER = 8.0;

interface TradeRow { id: number; entry: number; target: number; result: number; stake: number; pnl: number; time: string; }
interface Pending { entry: number; target: number; stake: number; }

function Trade() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [digits, setDigits] = useState<number[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  const [stake, setStake] = useState(1);
  const [tp, setTp] = useState(10);
  const [sl, setSl] = useState(5);
  const [running, setRunning] = useState(false);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [note, setNote] = useState("Idle");

  const pending = useRef<Pending | null>(null);
  const cfg = useRef({ running, stake, tp, sl, trades });
  cfg.current = { running, stake, tp, sl, trades };

  useEffect(() => {
    const e = session.get();
    if (!e) navigate({ to: "/" });
    else setEmail(e);
  }, [navigate]);

  useEffect(() => {
    const ws = new WebSocket(DERIV_WS_URL);
    ws.onopen = () => {
      setStatus("live");
      ws.send(JSON.stringify({ ticks_history: SYMBOL, count: WINDOW, end: "latest", style: "ticks", subscribe: 1 }));
    };
    ws.onclose = () => setStatus("offline");
    ws.onerror = () => setStatus("offline");
    ws.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.msg_type === "history") {
        const prices: number[] = data.history.prices;
        setDigits(prices.map((p) => lastDigit(p)));
        setPrice(prices[prices.length - 1] ?? null);
      } else if (data.msg_type === "tick") {
        const q: number = data.tick.quote;
        setPrice(q);
        setDigits((prev) => {
          const next = [...prev, lastDigit(q)];
          if (next.length > WINDOW) next.shift();
          onTick(next);
          return next;
        });
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTick(list: number[]) {
    const c = cfg.current;
    const d = list[list.length - 1] ?? 0;

    // Settle open contract on the next tick
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      const win = d === p.target;
      const pnl = win ? p.stake * WIN_MULTIPLIER : -p.stake;
      const row: TradeRow = {
        id: Date.now(), entry: p.entry, target: p.target, result: d, stake: p.stake, pnl,
        time: new Date().toLocaleTimeString(),
      };
      const all = [row, ...c.trades];
      setTrades(all);
      const total = all.reduce((s, t) => s + t.pnl, 0);
      const runs = all.length;
      if (total >= c.tp) return stop("Take profit reached");
      if (total <= -c.sl) return stop("Stop loss reached");
      if (runs >= MAX_RUNS) return stop(`${MAX_RUNS} runs complete`);
      setNote(win ? "Won. Analysing" : "Lost. Re-analysing market");
      return;
    }

    if (!c.running) return;
    const a = analyze(list);
    if (shouldEnter(a, d)) {
      pending.current = { entry: d, target: a.second, stake: c.stake };
      setNote(`Entered. Matching ${a.second}`);
    } else if (a.ok) {
      setNote(`Waiting for entry digit ${a.most}`);
    } else {
      setNote(`Spread ${a.diff.toFixed(2)} above ${MAX_DIFF}. Waiting`);
    }
  }

  function stop(msg: string) {
    setRunning(false);
    setNote(msg);
  }

  function start() {
    setTrades([]);
    pending.current = null;
    setRunning(true);
    setNote("Analysing");
  }

  const a = analyze(digits);
  const current = digits[digits.length - 1];
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const maxPct = Math.max(...a.percents, 1);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between border-b pb-6">
        <div className="flex items-baseline gap-4">
          <span className="font-display text-xl">Matches</span>
          <span className="label-caps">Volatility 100</span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <span className="label-caps flex items-center gap-2">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${status === "live" ? "bg-foreground" : "bg-faint"}`} />
            {status}
          </span>
          <span className="hidden text-muted-foreground sm:inline">{email}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => { session.clear(); navigate({ to: "/" }); }}>
            Sign out
          </button>
        </div>
      </header>

      <section className="grid gap-12 py-12 lg:grid-cols-[1fr_320px]">
        <div className="space-y-12">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <span className="label-caps">Spot</span>
              <div className="font-display num text-[clamp(3rem,7vw,5.5rem)] leading-none">
                {price !== null ? price.toFixed(2) : "—"}
              </div>
            </div>
            <div className="text-right">
              <span className="label-caps">Last digit</span>
              <div className="font-display num text-[clamp(3rem,7vw,5.5rem)] leading-none">{current ?? "—"}</div>
            </div>
          </div>

          <div>
            <div className="mb-4 flex items-baseline justify-between">
              <span className="label-caps">Digit distribution · last {a.total} ticks</span>
              <span className="label-caps num">
                Spread {a.diff.toFixed(2)} / {MAX_DIFF} · {a.ok ? "Within" : "Outside"}
              </span>
            </div>
            <div className="grid grid-cols-10 gap-2">
              {a.percents.map((p, d) => {
                const isMost = d === a.most;
                const isSecond = d === a.second;
                return (
                  <div key={d} className="flex flex-col items-center gap-2">
                    <div className="flex h-40 w-full items-end bg-muted">
                      <div
                        className={`w-full transition-[height] duration-500 ${isMost ? "bg-foreground" : isSecond ? "bg-muted-foreground" : "bg-faint/50"}`}
                        style={{ height: `${(p / maxPct) * 100}%` }}
                      />
                    </div>
                    <span className={`font-display text-lg num ${d === current ? "underline underline-offset-4" : ""}`}>{d}</span>
                    <span className="num text-xs text-muted-foreground">{p.toFixed(1)}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-6 grid grid-cols-2 border-t pt-6 sm:grid-cols-4">
              <Stat label="Entry (most)" value={`${a.most}`} sub={`${a.mostPct.toFixed(2)}%`} />
              <Stat label="Match (second)" value={`${a.second}`} sub={`${a.secondPct.toFixed(2)}%`} />
              <Stat label="Runs" value={`${trades.length}/${MAX_RUNS}`} sub={`${wins} won`} />
              <Stat label="P/L" value={`${total >= 0 ? "+" : ""}${total.toFixed(2)}`} sub="USD · simulated" />
            </div>
          </div>

          <div>
            <span className="label-caps">History</span>
            {trades.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">No trades yet. Set your stake and start the bot.</p>
            ) : (
              <table className="mt-4 w-full text-sm num">
                <thead>
                  <tr className="label-caps text-left">
                    <th className="py-2 font-normal">Time</th><th className="font-normal">Entry</th>
                    <th className="font-normal">Match</th><th className="font-normal">Result</th>
                    <th className="font-normal">Stake</th><th className="text-right font-normal">P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="py-3 text-muted-foreground">{t.time}</td><td>{t.entry}</td><td>{t.target}</td>
                      <td>{t.result}</td><td>{t.stake.toFixed(2)}</td>
                      <td className={`text-right ${t.pnl > 0 ? "font-semibold" : "text-muted-foreground"}`}>
                        {t.pnl > 0 ? "+" : ""}{t.pnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="space-y-8 lg:border-l lg:pl-10">
          <span className="label-caps">Bot settings</span>
          <Num label="Stake (USD)" value={stake} onChange={setStake} disabled={running} />
          <Num label="Take profit (USD)" value={tp} onChange={setTp} disabled={running} />
          <Num label="Stop loss (USD)" value={sl} onChange={setSl} disabled={running} />
          <div className="space-y-3 pt-2">
            {running ? (
              <button className="btn-line w-full" onClick={() => stop("Stopped")}>Stop bot</button>
            ) : (
              <button className="btn-solid w-full" disabled={status !== "live" || stake <= 0} onClick={start}>Start bot</button>
            )}
            <p className="text-sm text-muted-foreground">{note}</p>
          </div>
          <p className="border-t pt-6 text-xs leading-relaxed text-muted-foreground">
            Paper trading on live Volatility 100 ticks. Real orders are enabled once your Deriv account is connected.
          </p>
        </aside>
      </section>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="space-y-1 py-2">
      <span className="label-caps">{label}</span>
      <div className="font-display num text-3xl">{value}</div>
      <div className="num text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Num({ label, value, onChange, disabled }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="label-caps">{label}</span>
      <input
        className="field num font-display text-2xl disabled:text-muted-foreground"
        type="number" min={0} step="0.01" value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
