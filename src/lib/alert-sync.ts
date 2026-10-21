/**
 * Cross-device alert sync via Supabase Realtime broadcast.
 * Same Deriv account (or same email session) shares one room so every
 * open device can show OS / in-app notifications when the bot runs elsewhere.
 */

import { supabase } from "@/integrations/supabase/client";
import { session } from "@/lib/deriv-config";
import { getActiveAccountId } from "@/lib/deriv-auth";
import { removeTargets, upsertPeerTarget, type PushTarget } from "@/lib/push-targets";

const DEVICE_KEY = "thdpst_device_id";
const ROOM_OVERRIDE_KEY = "thdpst_alert_room";
const PEER_PUSH_PREFIX = "thdpst_peer_push_";
const OWN_PUSH_SUB_KEY = "thdpst_own_push_sub";
const PEER_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

type PushSubscriptionInfo = Pick<PushTarget, "endpoint" | "p256dh" | "auth">;

export type AlertKind =
  | "bot_start"
  | "bot_stop"
  | "win"
  | "loss"
  | "tp"
  | "sl"
  | "cycle"
  | "info";

export interface SyncedAlert {
  id: string;
  deviceId: string;
  roomId: string;
  kind: AlertKind;
  title: string;
  body: string;
  at: number;
}

type AlertHandler = (alert: SyncedAlert) => void;

let channel: ReturnType<typeof supabase.channel> | null = null;
let joinedRoom: string | null = null;
let channelSubscribed = false;
let handlers = new Set<AlertHandler>();
let publishQueue: SyncedAlert[] = [];

export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `dev-${Date.now()}`;
  }
}

/**
 * Room key shared by all devices logged into the same trader identity.
 * Prefer Deriv account id (stable across phones/desktops). Fall back to email.
 */
export function resolveAlertRoomId(accountId?: string | null): string | null {
  if (typeof window === "undefined") return null;

  try {
    const override = localStorage.getItem(ROOM_OVERRIDE_KEY)?.trim();
    if (override) return sanitizeRoom(override);
  } catch {
    // ignore
  }

  const acct = (accountId || getActiveAccountId() || "").trim();
  if (acct) return sanitizeRoom(`deriv-${acct.toUpperCase()}`);

  const email = (session.get() || "").trim().toLowerCase();
  if (email && email !== "deriv_trader") return sanitizeRoom(`user-${email}`);

  return null;
}

function sanitizeRoom(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);
}

function isHttpsEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizePushSubscription(value: unknown): PushSubscriptionInfo | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const endpoint = item["endpoint"];
  const p256dh = item["p256dh"];
  const auth = item["auth"];
  if (
    typeof endpoint !== "string" ||
    !isHttpsEndpoint(endpoint) ||
    typeof p256dh !== "string" ||
    !p256dh ||
    typeof auth !== "string" ||
    !auth
  ) {
    return null;
  }
  return { endpoint, p256dh, auth };
}

function getOwnPushSubscription(): PushSubscriptionInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(OWN_PUSH_SUB_KEY);
    return raw ? normalizePushSubscription(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveOwnPushSubscription(sub: PushSubscriptionInfo): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OWN_PUSH_SUB_KEY, JSON.stringify(sub));
  } catch {
    // ignore
  }
}

function peerPushKey(roomId: string): string {
  return `${PEER_PUSH_PREFIX}${roomId}`;
}

export function getPeerPushTargets(roomId: string): PushTarget[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(peerPushKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - PEER_MAX_AGE_MS;
    return parsed
      .filter((value): value is PushTarget => {
        if (!value || typeof value !== "object") return false;
        const target = value as Record<string, unknown>;
        return (
          typeof target["endpoint"] === "string" &&
          isHttpsEndpoint(target["endpoint"]) &&
          typeof target["p256dh"] === "string" &&
          Boolean(target["p256dh"]) &&
          typeof target["auth"] === "string" &&
          Boolean(target["auth"]) &&
          typeof target["deviceId"] === "string" &&
          Boolean(target["deviceId"]) &&
          typeof target["seenAt"] === "number" &&
          Number.isFinite(target["seenAt"]) &&
          target["seenAt"] >= cutoff
        );
      })
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function savePeerPushTargets(roomId: string, targets: PushTarget[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(peerPushKey(roomId), JSON.stringify(targets));
  } catch {
    // ignore
  }
}

export function dropPeerPushTargets(roomId: string, endpoints: string[]): void {
  savePeerPushTargets(roomId, removeTargets(getPeerPushTargets(roomId), endpoints));
}

export function clearOwnPushSubscription(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(OWN_PUSH_SUB_KEY);
  } catch {
    // ignore
  }
}

async function broadcastPushSubscription(
  sub: PushSubscriptionInfo,
  targetChannel: ReturnType<typeof supabase.channel> | null = channel,
): Promise<void> {
  if (!targetChannel) return;
  try {
    await targetChannel.send({
      type: "broadcast",
      event: "push_sub",
      payload: { deviceId: getDeviceId(), ...sub },
    });
  } catch {
    // ignore
  }
}

export async function announcePushSubscription(sub: PushSubscriptionInfo): Promise<void> {
  const validSub = normalizePushSubscription(sub);
  if (!validSub) return;
  saveOwnPushSubscription(validSub);
  if (channelSubscribed) await broadcastPushSubscription(validSub);
}

export function onSyncedAlert(handler: AlertHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function emitLocal(alert: SyncedAlert) {
  handlers.forEach((fn) => {
    try {
      fn(alert);
    } catch (err) {
      console.warn("[alert-sync] handler error:", err);
    }
  });
}

/**
 * Join (or re-join) the Realtime room for this trader.
 * Safe to call often — no-ops when already on the same room.
 */
export async function connectAlertSync(accountId?: string | null): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const roomId = resolveAlertRoomId(accountId);
  if (!roomId) {
    await disconnectAlertSync();
    return null;
  }

  if (channel && joinedRoom === roomId) return roomId;

  await disconnectAlertSync();

  const topic = `thdpst-alerts:${roomId}`;
  const next = supabase.channel(topic, {
    config: { broadcast: { self: false, ack: false } },
  });

  next.on("broadcast", { event: "alert" }, ({ payload }) => {
    const alert = normalizePayload(payload);
    if (!alert) return;
    if (alert.deviceId === getDeviceId()) return;
    emitLocal(alert);
  });

  next.on("broadcast", { event: "push_sub" }, ({ payload }) => {
    if (!payload || typeof payload !== "object") return;
    const item = payload as Record<string, unknown>;
    const deviceId = item["deviceId"];
    if (typeof deviceId !== "string" || !deviceId || deviceId === getDeviceId()) return;
    const sub = normalizePushSubscription(item);
    if (!sub) return;

    const result = upsertPeerTarget(getPeerPushTargets(roomId), {
      ...sub,
      deviceId,
      seenAt: Date.now(),
    });
    savePeerPushTargets(roomId, result.list);

    if (result.isNew) {
      const ownSub = getOwnPushSubscription();
      if (ownSub) void broadcastPushSubscription(ownSub, next);
    }
  });

  channel = next;
  joinedRoom = roomId;
  channelSubscribed = false;

  await new Promise<void>((resolve) => {
    next.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        if (channel === next) {
          channelSubscribed = true;
          const ownSub = getOwnPushSubscription();
          if (ownSub) void broadcastPushSubscription(ownSub, next);
        }
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        if (channel === next) channelSubscribed = false;
        resolve();
      }
    });
  });

  // Flush anything queued while we were connecting
  const pending = [...publishQueue];
  publishQueue = [];
  for (const alert of pending) {
    try {
      await channel?.send({
        type: "broadcast",
        event: "alert",
        payload: alert,
      });
    } catch {
      // ignore
    }
    await persistAlert(alert);
    await fanoutPush(alert);
    markAlertsSeen(roomId, alert.at);
  }

  return roomId;
}

export async function disconnectAlertSync(): Promise<void> {
  channelSubscribed = false;
  if (channel) {
    try {
      await supabase.removeChannel(channel);
    } catch {
      // ignore
    }
  }
  channel = null;
  joinedRoom = null;
}

function normalizePayload(payload: unknown): SyncedAlert | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const title = String(p["title"] || "").trim();
  const body = String(p["body"] || "").trim();
  if (!title) return null;
  return {
    id: String(p["id"] || `${Date.now()}`),
    deviceId: String(p["deviceId"] || ""),
    roomId: String(p["roomId"] || joinedRoom || ""),
    kind: (String(p["kind"] || "info") as AlertKind) || "info",
    title,
    body,
    at: Number(p["at"]) || Date.now(),
  };
}

const LAST_SEEN_PREFIX = "thdpst_alert_seen_";

function lastSeenKey(roomId: string) {
  return `${LAST_SEEN_PREFIX}${roomId}`;
}

export function markAlertsSeen(roomId: string, at = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(lastSeenKey(roomId), String(at));
  } catch {
    // ignore
  }
}

function getLastSeen(roomId: string): number {
  if (typeof window === "undefined") return Date.now() - 60_000;
  try {
    const raw = localStorage.getItem(lastSeenKey(roomId));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : Date.now() - 5 * 60_000;
  } catch {
    return Date.now() - 5 * 60_000;
  }
}

async function persistAlert(alert: SyncedAlert) {
  try {
    const { error } = await supabase.from("bot_alerts").insert({
      id: alert.id,
      room_id: alert.roomId,
      device_id: alert.deviceId,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      created_at: new Date(alert.at).toISOString(),
    });
    if (error) {
      // Table may not exist yet — Realtime broadcast still works
      console.warn("[alert-sync] persist skipped:", error.message);
    }
  } catch (err) {
    console.warn("[alert-sync] persist error:", err);
  }
}

async function fanoutPush(alert: SyncedAlert) {
  try {
    const { fanoutRemotePush } = await import("@/lib/push-client");
    await fanoutRemotePush({
      roomId: alert.roomId,
      title: alert.title,
      body: alert.body,
      kind: alert.kind,
      subscriptions: getPeerPushTargets(alert.roomId).map(
        ({ endpoint, p256dh, auth, deviceId }) => ({
          endpoint,
          p256dh,
          auth,
          deviceId,
        }),
      ),
    });
  } catch (err) {
    console.warn("[alert-sync] push fanout skipped:", err);
  }
}

/**
 * Pull alerts created while this device was offline / closed.
 */
export async function catchUpAlerts(accountId?: string | null): Promise<SyncedAlert[]> {
  const roomId = resolveAlertRoomId(accountId) || joinedRoom;
  if (!roomId) return [];

  const since = getLastSeen(roomId);
  try {
    const { data, error } = await supabase
      .from("bot_alerts")
      .select("id, room_id, device_id, kind, title, body, created_at")
      .eq("room_id", roomId)
      .gt("created_at", new Date(since).toISOString())
      .order("created_at", { ascending: true })
      .limit(25);

    if (error || !data) return [];

    const mine = getDeviceId();
    const alerts: SyncedAlert[] = data
      .filter((row) => row.device_id !== mine)
      .map((row) => ({
        id: row.id,
        deviceId: row.device_id,
        roomId: row.room_id,
        kind: (row.kind as AlertKind) || "info",
        title: row.title,
        body: row.body || "",
        at: new Date(row.created_at).getTime(),
      }));

    markAlertsSeen(roomId, Date.now());
    return alerts;
  } catch {
    return [];
  }
}

/**
 * Send an alert to every other device in the same room.
 * 1) Realtime broadcast (open apps)
 * 2) Persist to bot_alerts (catch-up on reopen)
 * 3) Web Push fan-out (closed / background apps)
 */
export async function publishSyncedAlert(
  title: string,
  body: string,
  kind: AlertKind = "info"
): Promise<void> {
  if (typeof window === "undefined") return;

  const roomId = joinedRoom || resolveAlertRoomId();
  if (!roomId) return;

  const alert: SyncedAlert = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `alert-${Date.now()}`,
    deviceId: getDeviceId(),
    roomId,
    kind,
    title,
    body,
    at: Date.now(),
  };

  if (!channel || joinedRoom !== roomId) {
    publishQueue.push(alert);
    await connectAlertSync();
    // connect flushes the queue via publish again — avoid double work below if still not ready
    if (!channel || joinedRoom !== roomId) {
      await persistAlert(alert);
      await fanoutPush(alert);
      markAlertsSeen(roomId, alert.at);
    }
    return;
  }

  try {
    await channel.send({
      type: "broadcast",
      event: "alert",
      payload: alert,
    });
  } catch (err) {
    console.warn("[alert-sync] publish failed:", err);
  }

  await persistAlert(alert);
  await fanoutPush(alert);
  markAlertsSeen(roomId, alert.at);
}

export function getJoinedAlertRoom(): string | null {
  return joinedRoom;
}
