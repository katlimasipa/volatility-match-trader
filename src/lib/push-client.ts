/**
 * Browser Web Push registration for closed-app / background alerts.
 */

import {
  announcePushSubscription,
  clearOwnPushSubscription,
  dropPeerPushTargets,
  getDeviceId,
  resolveAlertRoomId,
} from "@/lib/alert-sync";
import {
  fanoutPushAlert,
  getVapidPublicKey,
  registerPushSubscription,
  unregisterPushSubscription,
} from "@/lib/push.functions";

let cachedReg: ServiceWorkerRegistration | null = null;
let cachedVapidKey: string | null = null;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function getViteVapidKey(): string {
  return (
    (typeof import.meta !== "undefined"
      ? (import.meta.env?.["VITE_VAPID_PUBLIC_KEY"] as string | undefined)
      : "") || ""
  );
}

async function resolveVapidKey(): Promise<string> {
  try {
    const { publicKey } = await getVapidPublicKey();
    if (publicKey) return publicKey;
  } catch {
    // Use the client-side key as a fallback.
  }
  return getViteVapidKey();
}

export function isWebPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function preparePush(): Promise<void> {
  if (!isWebPushSupported()) return;
  try {
    const [reg, key] = await Promise.all([
      navigator.serviceWorker.ready,
      resolveVapidKey(),
    ]);
    cachedReg = reg;
    cachedVapidKey = key || null;
  } catch {
    // Push is prepared opportunistically; the gesture path can retry later.
  }
}

export function subscribePushFromGesture(): Promise<PushSubscription> | null {
  if (!cachedReg || !cachedVapidKey) return null;
  try {
    return cachedReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cachedVapidKey) as BufferSource,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Ask the browser for a push subscription and save it for the current room.
 */
export async function enableWebPush(
  accountId?: string | null,
  existingSub?: PushSubscription,
): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!isWebPushSupported()) {
    return { ok: false, error: "Web Push is not supported on this browser." };
  }
  if (Notification.permission !== "granted") {
    return { ok: false, error: "Notification permission is required first." };
  }

  const roomId = resolveAlertRoomId(accountId);
  if (!roomId) {
    return { ok: false, error: "Connect a Deriv account before enabling push sync." };
  }

  try {
    let sub = existingSub;
    if (!sub) {
      const key = cachedVapidKey || (await resolveVapidKey());
      if (!key) {
        return {
          ok: false,
          error: "Push keys are not configured on the server yet. Realtime alerts still work while the app is open.",
        };
      }
      cachedVapidKey = key;

      const reg = cachedReg || (await navigator.serviceWorker.ready);
      cachedReg = reg;
      sub = (await reg.pushManager.getSubscription()) ?? undefined;
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });
      }
    }

    const json = sub.toJSON();
    const keys = json.keys;
    const p256dh = keys ? keys["p256dh"] : undefined;
    const auth = keys ? keys["auth"] : undefined;
    if (!json.endpoint || !p256dh || !auth) {
      return { ok: false, error: "Browser did not return a valid push subscription." };
    }

    const subscription = { endpoint: json.endpoint, p256dh, auth };
    await announcePushSubscription(subscription);

    try {
      const res = await registerPushSubscription({
        data: {
          roomId,
          deviceId: getDeviceId(),
          ...subscription,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        },
      });
      if (!res.ok) {
        console.warn("[push-client] database subscription registration skipped:", res.error);
      }
    } catch (err) {
      console.warn("[push-client] database subscription registration failed:", err);
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Push subscription failed.",
    };
  }
}

export async function getPushStatus(): Promise<{
  supported: boolean;
  permission: string;
  subscribed: boolean;
}> {
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  if (!isWebPushSupported()) return { supported: false, permission, subscribed: false };

  try {
    const reg = cachedReg || (await navigator.serviceWorker.ready);
    cachedReg = reg;
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, permission, subscribed: Boolean(sub) };
  } catch {
    return { supported: true, permission, subscribed: false };
  }
}

export async function disableWebPush(): Promise<void> {
  clearOwnPushSubscription();
  if (!isWebPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await unregisterPushSubscription({ data: { endpoint } }).catch(() => {});
    }
  } catch {
    // ignore
  }
}

/**
 * Best-effort fan-out to closed / background devices in joined rooms.
 */
export async function fanoutRemotePush(opts: {
  roomId: string;
  title: string;
  body: string;
  kind?: string | undefined;
  alertId?: string | undefined;
  roomIds?: string[];
  subscriptions?: Array<{
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceId: string;
  }>;
}): Promise<void> {
  try {
    const res = await fanoutPushAlert({
      data: {
        roomId: opts.roomId,
        title: opts.title,
        body: opts.body,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.alertId ? { alertId: opts.alertId } : {}),
        subscriptions: opts.subscriptions ?? [],
        sourceDeviceId: getDeviceId(),
      },
    });
    if (res.stale.length > 0) {
      for (const roomId of new Set(opts.roomIds ?? [opts.roomId])) {
        dropPeerPushTargets(roomId, res.stale);
      }
    }
  } catch (err) {
    console.warn("[push-client] fanout failed:", err);
  }
}
