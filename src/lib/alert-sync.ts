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
    await publishSyncedAlert(alert.title, alert.body, alert.kind);
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

/**
 * Send an alert to every other device in the same room.
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
}

export function getJoinedAlertRoom(): string | null {
  return joinedRoom;
}
