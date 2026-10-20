import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { exchangeCodeForTokens, fetchDerivAccounts, setManualToken, setActiveAccountId, storeAccounts, type DerivAccount } from "@/lib/deriv-auth";
import { getDerivClientId, derivRedirectUri } from "@/lib/deriv-config";

export const Route = createFileRoute("/deriv/callback")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connecting Deriv — Matches" },
      { name: "description", content: "Authenticating with Deriv Auth 2.0." },
    ],
  }),
  component: Callback,
});

function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string>("Verifying authorization...");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      const url = new URL(window.location.href);
      const searchParams = url.searchParams;
      const hash = url.hash.startsWith("#") ? url.hash.substring(1) : "";
      const hashParams = new URLSearchParams(hash);

      // Check for error in query or hash
      const oauthError = searchParams.get("error") || hashParams.get("error");
      if (oauthError) {
        const desc = searchParams.get("error_description") || hashParams.get("error_description") || oauthError;
        setError(`Deriv authorization error: ${desc}`);
        return;
      }

      // Check for legacy OAuth token params (e.g. acct1=CR123&token1=xyz&acct2=VRTC456&token2=abc)
      const accountsFromParams: DerivAccount[] = [];
      let i = 1;
      while (searchParams.get(`acct${i}`) || hashParams.get(`acct${i}`)) {
        const accId = searchParams.get(`acct${i}`) || hashParams.get(`acct${i}`) || "";
        const token = searchParams.get(`token${i}`) || hashParams.get(`token${i}`) || "";
        const cur = searchParams.get(`cur${i}`) || hashParams.get(`cur${i}`) || "USD";
        if (accId) {
          const isDemo = accId.toUpperCase().startsWith("VRTC") || accId.toUpperCase().startsWith("V");
          accountsFromParams.push({
            account_id: accId,
            account_type: isDemo ? "demo" : "real",
            currency: cur,
            balance: "0.00",
          });
          if (token && (i === 1 || isDemo)) {
            setManualToken(token);
          }
        }
        i++;
      }

      if (accountsFromParams.length > 0) {
        storeAccounts(accountsFromParams);
        const demoAcc = accountsFromParams.find((a) => a.account_type === "demo") || accountsFromParams[0];
        if (demoAcc) setActiveAccountId(demoAcc.account_id);
        navigate({ to: "/trade" });
        return;
      }

      // Deriv Auth 2.0 PKCE Code Exchange
      const code = searchParams.get("code");
      const state = searchParams.get("state");

      if (!code || !state) {
        setError("Missing authorization code or state parameter. Please try connecting again.");
        return;
      }

      const clientId = getDerivClientId();
      if (!clientId) {
        setError("Deriv App ID is not configured. Please enter your App ID in the settings.");
        return;
      }

      try {
        setStep("Exchanging authorization code...");
        const redirectUri = derivRedirectUri();
        const authInfo = await exchangeCodeForTokens(code, state, clientId, redirectUri);

        setStep("Fetching trading accounts (Demo & Real)...");
        try {
          await fetchDerivAccounts(authInfo, clientId);
        } catch (accErr) {
          console.warn("Account list retrieval note:", accErr);
        }

        // Clean query parameters from URL
        window.history.replaceState({}, document.title, window.location.pathname);
        navigate({ to: "/trade" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to complete Deriv sign-in.");
      }
    })();
  }, [navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <div className="max-w-md space-y-6 border border-zinc-800 bg-zinc-950 p-8 text-center">
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 font-mono">Deriv Auth 2.0</span>
        <h1 className="font-mono text-2xl tracking-tight">
          {error ? "Connection Failed" : "Authenticating Account"}
        </h1>
        <p className="font-mono text-xs text-zinc-400">
          {error ?? step}
        </p>
        {error && (
          <div className="pt-4">
            <Link
              to="/trade"
              className="inline-flex h-10 items-center justify-center border border-zinc-700 px-6 font-mono text-xs uppercase tracking-wider text-white hover:bg-white hover:text-black transition-colors"
            >
              Return to Terminal
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
