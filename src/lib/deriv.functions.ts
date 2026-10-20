import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const exchangeDerivCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { code: string; verifier: string; redirectUri: string; clientId: string }) => {
    if (!d.code || !d.verifier || !d.redirectUri || !d.clientId) throw new Error("Missing parameters");
    return d;
  })
  .handler(async ({ data, context }) => {
    const res = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: data.clientId,
        code: data.code,
        code_verifier: data.verifier,
        redirect_uri: data.redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Deriv sign-in failed (${res.status})`);
    const tok = (await res.json()) as { access_token: string; expires_in?: number };

    let accounts: unknown = [];
    try {
      const a = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (a.ok) {
        const j = (await a.json()) as { data?: unknown };
        accounts = j.data ?? j;
      }
    } catch {
      // accounts are optional
    }

    const { error } = await context.supabase.from("deriv_connections").upsert({
      user_id: context.userId,
      access_token: tok.access_token,
      expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      accounts: accounts as never,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getDerivConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("deriv_connections")
      .select("accounts, expires_at, updated_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    return data;
  });

export const disconnectDeriv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("deriv_connections").delete().eq("user_id", context.userId);
    return { ok: true };
  });
