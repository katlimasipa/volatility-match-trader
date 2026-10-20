import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { session } from "@/lib/deriv-config";

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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    session.set(email);
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
          A single-purpose bot. One market, one contract type, three runs.
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
              <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block space-y-1">
              <span className="label-caps">Password</span>
              <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </div>

          <div className="space-y-3">
            <button type="submit" className="btn-solid w-full">
              {mode === "in" ? "Continue" : "Create account"}
            </button>
            <button type="button" disabled className="btn-line w-full" title="Available once Deriv app ID is connected">
              Continue with Deriv
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMode(mode === "in" ? "up" : "in")}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {mode === "in" ? "No account? Create one" : "Have an account? Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
