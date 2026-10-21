import { createServerFn } from "@tanstack/react-start";

type PushSubInput = {
  roomId: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

type FanoutInput = {
  roomId: string;
  title: string;
  body: string;
  kind?: string;
  sourceDeviceId?: string;
};

function getVapidConfig() {
  const publicKey =
    process.env["VAPID_PUBLIC_KEY"] ||
    process.env["VITE_VAPID_PUBLIC_KEY"] ||
    "";
  const privateKey = process.env["VAPID_PRIVATE_KEY"] || "";
  const subject = process.env["VAPID_SUBJECT"] || "mailto:alerts@thdpstmatches.vercel.app";
  return { publicKey, privateKey, subject };
}

/**
 * Save a browser push subscription for a Deriv-account alert room.
 */
export const registerPushSubscription = createServerFn({ method: "POST" })
  .inputValidator((d: PushSubInput) => {
    if (!d?.roomId || !d?.endpoint || !d?.p256dh || !d?.auth) {
      throw new Error("Missing push subscription fields");
    }
    return d;
  })
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
        {
          room_id: data.roomId,
          device_id: data.deviceId || "",
          endpoint: data.endpoint,
          p256dh: data.p256dh,
          auth: data.auth,
          user_agent: data.userAgent || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" }
      );
      if (error) {
        // Fall back to anon client if admin key is not configured
        const { supabase } = await import("@/integrations/supabase/client");
        const res = await supabase.from("push_subscriptions").upsert(
          {
            room_id: data.roomId,
            device_id: data.deviceId || "",
            endpoint: data.endpoint,
            p256dh: data.p256dh,
            auth: data.auth,
            user_agent: data.userAgent || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "endpoint" }
        );
        if (res.error) return { ok: false, error: res.error.message };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Could not save push subscription",
      };
    }
  });

export const unregisterPushSubscription = createServerFn({ method: "POST" })
  .inputValidator((d: { endpoint: string }) => {
    if (!d?.endpoint) throw new Error("Missing endpoint");
    return d;
  })
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", data.endpoint);
      return { ok: true };
    } catch {
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        await supabase.from("push_subscriptions").delete().eq("endpoint", data.endpoint);
      } catch {
        // ignore
      }
      return { ok: true };
    }
  });

/**
 * Fan-out a Web Push notification to every subscription in the room
 * (except the device that originated the alert).
 */
export const fanoutPushAlert = createServerFn({ method: "POST" })
  .inputValidator((d: FanoutInput) => {
    if (!d?.roomId || !d?.title) throw new Error("Missing fanout fields");
    return d;
  })
  .handler(async ({ data }) => {
    const vapid = getVapidConfig();
    if (!vapid.publicKey || !vapid.privateKey) {
      return { ok: false, sent: 0, reason: "vapid_not_configured" as const };
    }

    let rows: Array<{
      endpoint: string;
      p256dh: string;
      auth: string;
      device_id: string;
    }> = [];

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: list, error } = await supabaseAdmin
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth, device_id")
        .eq("room_id", data.roomId);
      if (error) throw error;
      rows = list || [];
    } catch {
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: list } = await supabase
          .from("push_subscriptions")
          .select("endpoint, p256dh, auth, device_id")
          .eq("room_id", data.roomId);
        rows = list || [];
      } catch {
        return { ok: false, sent: 0, reason: "db_unavailable" as const };
      }
    }

    const targets = rows.filter(
      (r) => !data.sourceDeviceId || r.device_id !== data.sourceDeviceId
    );
    if (targets.length === 0) {
      return { ok: true, sent: 0, reason: "no_targets" as const };
    }

    let webpush: typeof import("web-push");
    try {
      webpush = await import("web-push");
    } catch {
      return { ok: false, sent: 0, reason: "web_push_unavailable" as const };
    }

    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

    const payload = JSON.stringify({
      title: data.title,
      body: data.body || "",
      tag: `thdpst-${data.kind || "info"}-${Date.now()}`,
      icon: "/app-icon.png",
      badge: "/favicon.png",
      data: { url: "/trade" },
    });

    let sent = 0;
    const staleEndpoints: string[] = [];

    await Promise.all(
      targets.map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            payload,
            { TTL: 60 * 60 }
          );
          sent += 1;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            staleEndpoints.push(row.endpoint);
          }
        }
      })
    );

    if (staleEndpoints.length > 0) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
      } catch {
        // ignore cleanup failures
      }
    }

    return { ok: true, sent, reason: "sent" as const };
  });

export const getVapidPublicKey = createServerFn({ method: "GET" }).handler(async () => {
  const key =
    process.env["VAPID_PUBLIC_KEY"] ||
    process.env["VITE_VAPID_PUBLIC_KEY"] ||
    "";
  return { publicKey: key };
});
