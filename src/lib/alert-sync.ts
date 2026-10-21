/**
 * Cross-device alert sync via Supabase Realtime broadcast.
 * Same Deriv account (or same email session) shares one room so every
 * open device can show OS / in-app notifications when the bot runs elsewhere.
 */

import { supabase } from "@/integrations/supabase/client";
import { session } from "@/lib/deriv-config";
import { getActiveAccountId } from "@/lib/deriv-auth";

const DEVICE_KEY = "thdpst_device_id";
const ROOM_OVERRIDE_KEY = "thdpst_alert_room";

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

  channel = next;
  joinedRoom = roomId;

  await new Promise<void>((resolve) => {
    next.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
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
