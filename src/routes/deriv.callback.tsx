import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { consumePkce, DERIV_CLIENT_ID, derivRedirectUri } from "@/lib/deriv-config";
import { exchangeDerivCode } from "@/lib/deriv.functions";

export const Route = createFileRoute("/deriv/callback")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connecting Deriv — Matches" },
      { name: "description", content: "Finishing your Deriv sign-in." },
      { property: "og:title", content: "Connecting Deriv — Matches" },
      { property: "og:description", content: "Finishing your Deriv sign-in." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Callback,
});

function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const q = new URLSearchParams(window.location.search);
      if (q.get("error")) return setError(q.get("error_description") ?? "Deriv sign-in was cancelled.");
      const verifier = consumePkce(q.get("state"));
      const code = q.get("code");
      if (!verifier || !code) return setError("This sign-in link is invalid or expired. Please try again.");
      const { data } = await supabase.auth.getUser();
      if (!data.user) return setError("Sign in with your email first, then connect Deriv.");
      try {
        await exchangeDerivCode({ data: { code, verifier, redirectUri: derivRedirectUri(), clientId: DERIV_CLIENT_ID } });
        navigate({ to: "/trade" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not connect Deriv.");
      }
    })();
  }, [navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm space-y-4 text-center rise">
        <span className="label-caps">Deriv</span>
        <h1 className="font-display text-3xl">{error ? "Connection failed" : "Connecting your account"}</h1>
        <p className="text-sm text-muted-foreground">{error ?? "One moment."}</p>
        {error && <Link to="/trade" className="btn-line">Back</Link>}
      </div>
    </main>
  );
}
