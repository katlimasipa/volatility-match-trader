/**
 * Cross-device alert sync via Supabase Realtime broadcast.
 * Devices share all signed-in Deriv account rooms so alerts reach every device.
 */

import { supabase } from "@/integrations/supabase/client";
import { session } from "@/lib/deriv-config";
import { getActiveAccountId, getStoredAccounts } from "@/lib/deriv-auth";
import { removeTargets, upsertPeerTarget, type PushTarget } from "@/lib/push-targets";

const DEVICE_KEY = "thdpst_device_id";
const ROOM_OVERRIDE_KEY = "thdpst_alert_room";
const PEER_PUSH_PREFIX = "thdpst_peer_push_";
const OWN_PUSH_SUB_KEY = "thdpst_own_push_sub";
const PEER_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

type PushSubscriptionInfo = Pick<PushTarget, "endpoint" | "p256dh" | "auth">;

export type AlertKind =
  "bot_start" | "bot_stop" | "win" | "loss" | "tp" | "sl" | "cycle" | "error" | "info";

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
type AlertChannel = ReturnType<typeof supabase.channel>;

const channels = new Map<string, AlertChannel>();
const subscribedRooms = new Set<string>();
const channelSubscriptions = new Map<string, Promise<void>>();
const handlers = new Set<AlertHandler>();
const recentAlertIds = new Set<string>();
let primaryRoom: string | null = null;
const publishQueue: SyncedAlert[] = [];

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
 * Primary room shared by devices logged into the same trader identity.
 * Prefer Deriv account id (stable across phones/desktops). Fall back to email.
 */
export function resolveAlertRoomId(accountId?: string | null): string | null {
  return resolveAlertRoomIds(accountId)[0] || null;
}

export function resolveAlertRoomIds(accountId?: string | null): string[] {
  if (typeof window === "undefined") return [];

  try {
    const override = localStorage.getItem(ROOM_OVERRIDE_KEY)?.trim();
    if (override) return [sanitizeRoom(override)];
  } catch {
    // ignore
  }

  const accountIds = [
    accountId || getActiveAccountId(),
    ...getStoredAccounts().map((account) => account.account_id),
  ];
  const rooms: string[] = [];
  for (const id of accountIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const roomId = sanitizeRoom(`deriv-${id.trim().toUpperCase()}`);
    if (!rooms.includes(roomId)) rooms.push(roomId);
    if (rooms.length === 10) return rooms;
  }
  if (rooms.length > 0) return rooms;

  const email = (session.get() || "").trim().toLowerCase();
  if (email && email !== "deriv_trader") return [sanitizeRoom(`user-${email}`)];

  return [];
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
  targetChannel: AlertChannel,
): Promise<void> {
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
  await Promise.all(
    [...channels.entries()]
      .filter(([roomId]) => subscribedRooms.has(roomId))
      .map(([, targetChannel]) => broadcastPushSubscription(validSub, targetChannel)),
  );
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

function rememberAlertId(id: string): boolean {
  if (!id || recentAlertIds.has(id)) return false;
  recentAlertIds.add(id);
  if (recentAlertIds.size > 300) {
    const oldest = recentAlertIds.values().next().value;
    if (oldest) recentAlertIds.delete(oldest);
  }
  return true;
}

function subscribeAlertRoom(roomId: string): Promise<void> {
  const existing = channels.get(roomId);
  if (existing) return channelSubscriptions.get(roomId) || Promise.resolve();

  const topic = `thdpst-alerts:${roomId}`;
  const next = supabase.channel(topic, {
    config: { broadcast: { self: false, ack: false } },
  });

  next.on("broadcast", { event: "alert" }, ({ payload }) => {
    const alert = normalizePayload(payload, roomId);
    if (!alert || alert.deviceId === getDeviceId()) return;
    if (!rememberAlertId(alert.id)) return;
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

  channels.set(roomId, next);
  subscribedRooms.delete(roomId);
  const subscription = new Promise<void>((resolve) => {
    next.subscribe((status) => {
      if (channels.get(roomId) !== next) {
        resolve();
        return;
      }
      if (status === "SUBSCRIBED") {
        subscribedRooms.add(roomId);
        const ownSub = getOwnPushSubscription();
        if (ownSub) void broadcastPushSubscription(ownSub, next);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        subscribedRooms.delete(roomId);
        resolve();
      }
    });
  });
  channelSubscriptions.set(roomId, subscription);
  return subscription;
}

async function broadcastAlert(alert: SyncedAlert): Promise<void> {
  await Promise.all(
    [...channels.values()].map(async (targetChannel) => {
      try {
        await targetChannel.send({
          type: "broadcast",
          event: "alert",
          payload: alert,
        });
      } catch {
        // ignore
      }
    }),
  );
}

async function publishAlert(alert: SyncedAlert): Promise<void> {
  await broadcastAlert(alert);
  await persistAlert(alert);
  await fanoutPush(alert);
  markAlertsSeen(alert.roomId, alert.at);
}

async function flushPublishQueue(): Promise<void> {
  const pending = publishQueue.splice(0);
  for (const alert of pending) {
    await publishAlert(alert);
  }
}

/**
 * Join (or re-join) the Realtime rooms for this trader.
 * Safe to call often — reuses channels for rooms that are still needed.
 */
export async function connectAlertSync(accountId?: string | null): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const roomIds = resolveAlertRoomIds(accountId);
  const nextPrimary = roomIds[0] || null;
  if (!nextPrimary) {
    await disconnectAlertSync();
    return null;
  }

  primaryRoom = nextPrimary;
  const desiredRooms = new Set(roomIds);
  const removed: AlertChannel[] = [];
  for (const [roomId, oldChannel] of channels) {
    if (desiredRooms.has(roomId)) continue;
    channels.delete(roomId);
    subscribedRooms.delete(roomId);
    channelSubscriptions.delete(roomId);
    removed.push(oldChannel);
  }
  await Promise.all(
    removed.map(async (oldChannel) => {
      try {
        await supabase.removeChannel(oldChannel);
      } catch {
        // ignore
      }
    }),
  );

  await Promise.all(roomIds.map((roomId) => subscribeAlertRoom(roomId)));
  await flushPublishQueue();
  return nextPrimary;
}

export async function disconnectAlertSync(): Promise<void> {
  const existing = [...channels.values()];
  channels.clear();
  subscribedRooms.clear();
  channelSubscriptions.clear();
  primaryRoom = null;
  await Promise.all(
    existing.map(async (targetChannel) => {
      try {
        await supabase.removeChannel(targetChannel);
      } catch {
        // ignore
      }
    }),
  );
}

function normalizePayload(payload: unknown, fallbackRoomId?: string): SyncedAlert | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const title = String(p["title"] || "").trim();
  const body = String(p["body"] || "").trim();
  if (!title) return null;
  return {
    id: String(p["id"] || `${Date.now()}`),
    deviceId: String(p["deviceId"] || ""),
    roomId: String(p["roomId"] || fallbackRoomId || primaryRoom || ""),
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
    const targets = new Map<
      string,
      { endpoint: string; p256dh: string; auth: string; deviceId: string }
    >();
    const roomIds = [...channels.keys()];
    for (const roomId of roomIds) {
      for (const { endpoint, p256dh, auth, deviceId } of getPeerPushTargets(roomId)) {
        if (!targets.has(endpoint)) {
          targets.set(endpoint, { endpoint, p256dh, auth, deviceId });
        }
      }
    }
    await fanoutRemotePush({
      roomId: alert.roomId,
      roomIds: roomIds.length > 0 ? roomIds : [alert.roomId],
      title: alert.title,
      body: alert.body,
      kind: alert.kind,
      alertId: alert.id,
      subscriptions: [...targets.values()],
    });
  } catch (err) {
    console.warn("[alert-sync] push fanout skipped:", err);
  }
}

/**
 * Pull alerts created while this device was offline / closed.
 */
export async function catchUpAlerts(accountId?: string | null): Promise<SyncedAlert[]> {
  const roomIds = resolveAlertRoomIds(accountId);
  if (roomIds.length === 0) return [];

  const mine = getDeviceId();
  const results = await Promise.all(
    roomIds.map(async (roomId) => {
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
        markAlertsSeen(roomId, Date.now());
        return data
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
      } catch {
        return [];
      }
    }),
  );

  const alerts: SyncedAlert[] = [];
  for (const alert of results.flat().sort((a, b) => a.at - b.at)) {
    if (rememberAlertId(alert.id)) alerts.push(alert);
  }
  return alerts.slice(0, 25);
}

/**
 * Send an alert to every other device in the joined account rooms.
 * 1) Realtime broadcast (open apps)
 * 2) Persist to bot_alerts (catch-up on reopen)
 * 3) Web Push fan-out (closed / background apps)
 */
export async function publishSyncedAlert(
  title: string,
  body: string,
  kind: AlertKind = "info",
): Promise<void> {
  if (typeof window === "undefined") return;

  const roomIds = resolveAlertRoomIds();
  const roomId = roomIds[0];
  if (!roomId) return;
  primaryRoom = roomId;

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

  const allRoomsConnected =
    channels.size === roomIds.length &&
    roomIds.every(
      (joinedRoomId) => channels.has(joinedRoomId) && subscribedRooms.has(joinedRoomId),
    );
  if (!allRoomsConnected) {
    publishQueue.push(alert);
    await connectAlertSync();
    return;
  }

  await publishAlert(alert);
}

export function getJoinedAlertRoom(): string | null {
  return primaryRoom;
}
