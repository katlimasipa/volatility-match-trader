import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { session, getDerivClientId, derivRedirectUri } from "@/lib/deriv-config";
import { startDerivAuth, handleIncomingOAuth } from "@/lib/deriv-auth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Matches // Volatility 100 Trader" },
      { name: "description", content: "Monochrome Deriv Matches strategy terminal for Volatility 100." },
    ],
  }),
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // 1. Check for incoming Deriv OAuth 2.0 callback params
    handleIncomingOAuth().then((res) => {
      if (res.handled) {
        if (res.success) {
          session.set("deriv_trader");
          navigate({ to: "/trade" });
          return;
        } else if (res.error) {
          setMsg(`Deriv authentication error: ${res.error}`);
        }
      }
    });

    // 2. Check existing session
    const existing = session.get();
    if (existing) {
      navigate({ to: "/trade" });
      return;
    }

    // 3. Check Supabase session
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) {
        session.set(data.user.email);
        navigate({ to: "/trade" });
      }
    }).catch(() => {});
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setMsg(null);

    try {
      if (mode === "up") {
        await supabase.auth.signUp({ email, password }).catch(() => {});
        session.set(email);
        setBusy(false);
        navigate({ to: "/trade" });
        return;
      }

      await supabase.auth.signInWithPassword({ email, password }).catch(() => {});
      session.set(email);
      setBusy(false);
      navigate({ to: "/trade" });
    } catch {
      session.set(email);
      setBusy(false);
      navigate({ to: "/trade" });
    }
  };

  const onConnectDeriv = async () => {
    setBusy(true);
    setMsg("Initiating Deriv Auth 2.0...");
    try {
      await startDerivAuth({
        clientId: getDerivClientId(),
        redirectUri: derivRedirectUri(),
      });
    } catch (e) {
      setBusy(false);
      setMsg(e instanceof Error ? e.message : "Failed to initiate Deriv authorization.");
    }
  };

  return (
    <main className="grid min-h-screen bg-black text-white md:grid-cols-[1.1fr_1fr]">
      {/* Brand & Strategy Overview */}
      <section className="hidden flex-col justify-between border-r border-zinc-900 bg-zinc-950 p-12 md:flex">
        <div className="flex items-center gap-3">
          <img src="/app-icon.png" alt="Icon" className="h-8 w-8 rounded-full border border-zinc-800" />
          <span className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-400">
            DERIV // VOLATILITY 100
          </span>
        </div>

        <div className="space-y-6">
          <img src="/logo.png" alt="ThDpst Matches" className="h-16 w-auto max-w-[280px] object-contain" />
          <h1 className="font-mono text-4xl font-light tracking-tight text-white lg:text-5xl">
            Precision Match.
            <br />
            Monochrome Edge.
          </h1>
          <p className="max-w-md font-mono text-xs leading-relaxed text-zinc-400">
            Automated Deriv Matches strategy exclusively on Volatility 100. Real-time digit distribution analysis, strict spread validation, and Deriv Auth 2.0 integration for Demo and Real accounts.
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-900 pt-6 font-mono text-[11px] text-zinc-600">
          <span>RULE: SPREAD ≤ 0.3%</span>
          <span>CYCLE: 3 RUNS</span>
          <span>IF LOSS: RE-ANALYZE</span>
        </div>
      </section>

      {/* Auth Form & Deriv Direct Connect */}
      <section className="flex items-center justify-center bg-black px-6 py-16">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-4 border-b border-zinc-900 pb-4">
            <img src="/app-icon.png" alt="Icon" className="h-12 w-12 rounded-full border border-zinc-800" />
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                {mode === "in" ? "Authentication" : "Register"}
              </span>
              <h2 className="font-mono text-2xl tracking-tight text-white">
                {mode === "in" ? "Sign In" : "Create Account"}
              </h2>
            </div>
          </div>

          {/* Deriv Auth 2.0 Direct Access */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={onConnectDeriv}
              disabled={busy}
              className="w-full border border-white bg-white py-3 font-mono text-xs uppercase tracking-[0.2em] text-black hover:bg-zinc-200 transition-colors disabled:opacity-50"
            >
              Sign In with Deriv Auth 2.0
            </button>
            <p className="text-center font-mono text-[10px] text-zinc-500">
              One-click access with your Deriv Demo & Real accounts
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-900" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              OR EMAIL
            </span>
            <div className="h-px flex-1 bg-zinc-900" />
          </div>

          <form onSubmit={submit} className="space-y-5">
            <label className="block space-y-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">
                Email Address
              </span>
              <input
                className="w-full border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-sm text-white placeholder-zinc-700 outline-none transition-colors focus:border-white"
                type="email"
                autoComplete="email"
                placeholder="trader@deriv.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className="block space-y-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">
                Password
              </span>
              <input
                className="w-full border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-sm text-white placeholder-zinc-700 outline-none transition-colors focus:border-white"
                type="password"
                minLength={6}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>

            <div className="space-y-3 pt-2">
              <button
                type="submit"
                disabled={busy}
                className="w-full border border-zinc-800 bg-zinc-900 py-3 font-mono text-xs uppercase tracking-[0.2em] text-zinc-200 hover:border-zinc-600 hover:text-white transition-all disabled:opacity-50"
              >
                {busy ? "Authenticating..." : mode === "in" ? "Enter with Email" : "Create Account"}
              </button>
              {msg && <p className="font-mono text-xs text-zinc-400">{msg}</p>}
            </div>

            <div className="flex items-center justify-between border-t border-zinc-900 pt-4 font-mono text-xs text-zinc-500">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "in" ? "up" : "in");
                  setMsg(null);
                }}
                className="underline-offset-4 hover:text-white hover:underline transition-colors"
              >
                {mode === "in" ? "Need an account? Register" : "Already registered? Sign in"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
