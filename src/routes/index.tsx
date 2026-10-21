import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { session, getDerivClientId, derivRedirectUri, isOAuthOriginReady } from "@/lib/deriv-config";
import {
  startDerivAuth,
  handleIncomingOAuth,
  authorizeWithToken,
  isStandaloneIosPwa,
} from "@/lib/deriv-auth";
import { isIOS, isRunningStandalone } from "@/lib/pwa";

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
  const [oauthLoading, setOauthLoading] = useState(false);

  // Deriv direct token access (guaranteed to work on iOS PWA without redirect issues)
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    // 1. Detect incoming OAuth callback immediately
    const hasIncomingOAuth =
      typeof window !== "undefined" &&
      (window.location.search.includes("code=") ||
        window.location.search.includes("token1=") ||
        window.location.search.includes("error=") ||
        window.location.hash.includes("code=") ||
        window.location.hash.includes("token1="));

    if (hasIncomingOAuth) {
      setOauthLoading(true);
      setBusy(true);
      setMsg("Authorizing with Deriv Auth 2.0... Exchanging credentials...");

      handleIncomingOAuth().then((res) => {
        setOauthLoading(false);
        setBusy(false);
        if (res.handled) {
          if (res.success) {
            session.set("deriv_trader");
            navigate({ to: "/trade" });
            return;
          } else if (res.error) {
            setMsg(`Deriv authentication notice: ${res.error}. You can also use your API Token below.`);
          }
        }
      });
      return; // DO NOT check existing session or navigate away while OAuth exchange is in flight!
    }

    // 2. Check existing session only when NOT handling OAuth callback
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
    // iOS home-screen apps open OAuth in Safari and cannot return into the PWA
    if (isStandaloneIosPwa() || (isRunningStandalone() && isIOS())) {
      setShowTokenInput(true);
      setMsg(
        "On the iPhone app, paste a Deriv API token below (Read + Trade). Auth 2.0 login opens in Safari and cannot return here."
      );
      return;
    }
    if (!isOAuthOriginReady()) {
      setShowTokenInput(true);
      setMsg(
        `Auth 2.0 login works on ${derivRedirectUri()}. Open that link, or paste an API token below.`
      );
      return;
    }
    setBusy(true);
    setMsg("Opening Deriv Auth 2.0...");
    try {
      await startDerivAuth({
        clientId: getDerivClientId(),
        redirectUri: derivRedirectUri(),
      });
    } catch (e) {
      setBusy(false);
      setMsg(e instanceof Error ? e.message : "Could not start Deriv login.");
    }
  };

  const handleAuthorizeToken = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiToken.trim()) return;

    setTokenBusy(true);
    setTokenError(null);

    try {
      const res = await authorizeWithToken(apiToken.trim());
      if (res.success) {
        session.set("deriv_trader");
        navigate({ to: "/trade" });
      } else {
        setTokenError(res.error || "Failed to authorize token with Deriv.");
      }
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Authorization error.");
    } finally {
      setTokenBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen bg-black text-white md:grid-cols-[1.1fr_1fr]">
      {/* Brand & Strategy Overview */}
      <section className="hidden flex-col justify-between border-r border-zinc-900 bg-zinc-950 p-12 md:flex">
        <div className="flex items-center gap-3">
          <img src="/app-icon.png" alt="Icon" className="h-8 w-8 rounded-full border border-zinc-800" />
          <span className="text-xs uppercase tracking-[0.25em] text-zinc-400">
            DERIV // VOLATILITY 100
          </span>
        </div>

        <div className="space-y-6">
          <img src="/logo.png" alt="ThDpst Matches" className="h-16 w-auto max-w-[280px] object-contain invert" />
          <h1 className="font-display text-4xl tracking-tight text-white lg:text-5xl">
            Volatility 100
            <br />
            <span className="text-zinc-300">Matches terminal</span>
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-zinc-400">
            Sign in with Deriv Auth 2.0, scan the last 1,000 digits, and place live DIGITMATCH trades. Your balance updates on every trade in the app and on Deriv.
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-900 pt-6 font-mono text-[11px] text-zinc-600">
          <span>RULE: SPREAD ≤ 0.3%</span>
          <span>CYCLE: 3 RUNS</span>
          <span>IF LOSS: RE-ANALYZE</span>
          <a
            href="https://architeq.co.za"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-400 hover:text-white hover:underline font-semibold"
          >
            Built by Architeq Web Agency ↗
          </a>
        </div>
      </section>

      {/* Auth Form & Deriv Direct Connect */}
      <section className="flex items-center justify-center bg-black px-6 py-12">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center gap-4 border-b border-zinc-900 pb-4">
            <img src="/app-icon.png" alt="Icon" className="h-12 w-12 rounded-full border border-zinc-800" />
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                {mode === "in" ? "Authentication" : "Register"}
              </span>
              <h2 className="font-display text-2xl tracking-tight text-white">
                {mode === "in" ? "Sign In" : "Create Account"}
              </h2>
            </div>
          </div>

          {/* Deriv Auth 2.0 & Direct Permission Access */}
          {oauthLoading ? (
            <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-6 text-center space-y-4">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <div className="space-y-1">
                <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-white">
                  Connecting Deriv…
                </h3>
                <p className="font-mono text-xs text-zinc-400">
                  Exchanging Auth 2.0 credentials and loading your accounts.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={onConnectDeriv}
                disabled={busy}
                className="w-full border border-white bg-white py-3 font-mono text-xs uppercase tracking-[0.2em] text-black hover:bg-zinc-200 transition-colors disabled:opacity-50 font-bold"
              >
                Sign In with Deriv Auth 2.0
              </button>

            <button
              type="button"
              onClick={() => {
                setShowTokenInput(!showTokenInput);
                setTokenError(null);
              }}
              className="w-full border border-zinc-800 bg-zinc-900/60 py-2.5 font-mono text-xs uppercase tracking-wider text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
            >
              {showTokenInput ? "Hide token login" : "Use API token (iPhone app / backup)"}
            </button>

            {showTokenInput && (
              <form onSubmit={handleAuthorizeToken} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
                      Deriv API token
                    </span>
                    <a
                      href="https://app.deriv.com/account/api-token"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-zinc-400 hover:text-white hover:underline"
                    >
                      Create token ↗
                    </a>
                  </div>
                  <p className="font-mono text-[10px] text-zinc-500 leading-tight">
                    Required on the iPhone home-screen app. In Deriv, open Settings → API token, enable Read and Trade, then paste it here.
                  </p>
                </div>

                <input
                  type="text"
                  placeholder="Paste your Deriv API token here"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="w-full rounded border border-zinc-800 bg-black px-3 py-2 font-mono text-xs text-white placeholder-zinc-700 outline-none focus:border-zinc-600"
                  required
                />

                {tokenError && (
                  <p className="font-mono text-[11px] text-zinc-300 leading-tight">
                    {tokenError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={tokenBusy || !apiToken.trim()}
                  className="w-full rounded bg-white py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-black hover:bg-zinc-200 transition-colors disabled:opacity-40"
                >
                  {tokenBusy ? "Authorizing…" : "Connect & enter"}
                </button>
              </form>
            )}

            <p className="text-center font-mono text-[10px] text-zinc-500">
              Access your Deriv Demo & Real accounts with automated execution
            </p>
            {msg && <p className="font-mono text-xs text-zinc-400 text-center">{msg}</p>}
          </div>
          )}

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-900" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              OR EMAIL
            </span>
            <div className="h-px flex-1 bg-zinc-900" />
          </div>

          <form onSubmit={submit} className="space-y-4">
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

            <div className="space-y-2 pt-2">
              <button
                type="submit"
                disabled={busy}
                className="w-full border border-zinc-800 bg-zinc-900 py-3 font-mono text-xs uppercase tracking-[0.2em] text-zinc-200 hover:border-zinc-600 hover:text-white transition-all disabled:opacity-50"
              >
                {busy ? "Authenticating..." : mode === "in" ? "Enter with Email" : "Create Account"}
              </button>
            </div>

            <div className="flex items-center justify-between border-t border-zinc-900 pt-3 font-mono text-xs text-zinc-500">
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

          {/* Footer */}
          <footer className="pt-4 border-t border-zinc-900 text-center font-mono text-xs text-zinc-500">
            <span>Built by </span>
            <a
              href="https://architeq.co.za"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 hover:text-white hover:underline font-bold"
            >
              Architeq Web Agency ↗
            </a>
          </footer>
        </div>
      </section>
    </main>
  );
}
