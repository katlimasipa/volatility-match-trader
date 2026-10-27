import { useEffect, useState } from "react";
import { onInAppAlert } from "@/lib/notifications";

type InAppAlert = {
  id: number;
  title: string;
  body: string;
  type: "win" | "loss" | "info" | "warning";
};

type Theme = "dark" | "light";

function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem("thdpst_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function InAppNotificationHost() {
  const [alert, setAlert] = useState<InAppAlert | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const unsubscribe = onInAppAlert((nextAlert) => {
      setAlert(nextAlert);
      setTheme(readTheme());
    });

    const updateTheme = () => setTheme(readTheme());
    window.addEventListener("storage", updateTheme);
    window.addEventListener("thdpst-theme-change", updateTheme);

    return () => {
      unsubscribe();
      window.removeEventListener("storage", updateTheme);
      window.removeEventListener("thdpst-theme-change", updateTheme);
    };
  }, []);

  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => {
      setAlert((current) => (current?.id === alert.id ? null : current));
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [alert]);

  if (!alert) return null;

  const isDark = theme === "dark";
  const colors =
    alert.type === "win"
      ? isDark
        ? "border-emerald-500/60 bg-zinc-950 text-emerald-400"
        : "border-emerald-500 bg-emerald-50 text-emerald-800"
      : alert.type === "loss"
        ? isDark
          ? "border-red-500/60 bg-zinc-950 text-red-400"
          : "border-red-500 bg-red-50 text-red-800"
        : isDark
          ? "border-zinc-700 bg-zinc-950 text-zinc-100"
          : "border-slate-300 bg-white text-slate-900";
  const indicator =
    alert.type === "win"
      ? "bg-emerald-400"
      : alert.type === "loss"
        ? "bg-rose-500"
        : alert.type === "warning"
          ? "bg-amber-400"
          : "bg-sky-400";

  return (
    <section
      aria-label="Notifications"
      className="w-full px-3 pt-3 sm:px-6"
    >
      <aside
        role="status"
        aria-live="polite"
        className={`mx-auto flex w-full max-w-[1560px] animate-in fade-in slide-in-from-top-2 items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-lg duration-200 ${colors}`}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider">
            <span className={`h-2 w-2 shrink-0 rounded-full ${indicator}`} />
            <span className="truncate">{alert.title}</span>
          </div>
          {alert.body && (
            <div className="break-words text-[11px] leading-snug opacity-90">
              {alert.body}
            </div>
          )}
        </div>
        <button
          onClick={() => setAlert(null)}
          aria-label="Dismiss notification"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-sm font-bold opacity-60 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ×
        </button>
      </aside>
    </section>
  );
}
