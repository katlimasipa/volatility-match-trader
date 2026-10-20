import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Matches — Sign in" },
      { name: "description", content: "Sign in to the Volatility 100 Matches trader." },
      { property: "og:title", content: "Matches — Sign in" },
      { property: "og:description", content: "Sign in to the Volatility 100 Matches trader." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
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
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/trade" });
    });
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "up") {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { emailRedirectTo: window.location.origin },
      });
      setBusy(false);
      if (error) return setMsg(error.message);
      if (!data.session) {
        setMode("in");
        return setMsg("Check your inbox to confirm your email, then sign in.");
      }
      return navigate({ to: "/trade" });
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setMsg(error.message);
    navigate({ to: "/trade" });
  };

  return (
    <main className="grid min-h-screen md:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between bg-primary p-12 text-primary-foreground md:flex">
        <span className="label-caps text-primary-foreground/60">Volatility 100 / Matches</span>
        <h1 className="font-display text-[clamp(3rem,6vw,5.5rem)] leading-[0.95] rise">
          Read the digits.
          <br />
          Trade the match.
        </h1>
        <p className="max-w-sm text-sm text-primary-foreground/60">
          Create your account, then link Deriv to trade.
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-16">
        <form onSubmit={submit} className="w-full max-w-sm space-y-10 rise">
          <div className="space-y-2">
            <span className="label-caps">{mode === "in" ? "Welcome back" : "New account"}</span>
            <h2 className="font-display text-4xl">{mode === "in" ? "Sign in" : "Create account"}</h2>
          </div>

          <div className="space-y-6">
            <label className="block space-y-1">
              <span className="label-caps">Email</span>
              <input className="field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block space-y-1">
              <span className="label-caps">Password</span>
              <input className="field" type="password" minLength={6} autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </div>

          <div className="space-y-3">
            <button type="submit" disabled={busy} className="btn-solid w-full">
              {busy ? "Please wait" : mode === "in" ? "Sign in" : "Create account"}
            </button>
            {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          </div>

          <button
            type="button"
            onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {mode === "in" ? "No account? Create one" : "Have an account? Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
