export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId: string;
  seenAt: number;
}

export interface PushFanoutTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string;
}

type DbPushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string;
};

type ProvidedPushTarget = Omit<PushTarget, "seenAt"> & { seenAt?: number };

function isHttpsEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

export function mergePushTargets(
  dbRows: DbPushTarget[],
  provided: ProvidedPushTarget[],
  sourceDeviceId?: string,
): PushFanoutTarget[] {
  const targets = new Map<string, PushFanoutTarget>();

  for (const row of dbRows) {
    if (!row.endpoint || !isHttpsEndpoint(row.endpoint)) continue;
    if (sourceDeviceId !== undefined && row.device_id === sourceDeviceId) continue;
    targets.set(row.endpoint, {
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      device_id: row.device_id,
    });
  }

  for (const target of provided) {
    if (!target.endpoint || !isHttpsEndpoint(target.endpoint)) continue;
    if (sourceDeviceId !== undefined && target.deviceId === sourceDeviceId) continue;
    if (targets.has(target.endpoint)) continue;
    targets.set(target.endpoint, {
      endpoint: target.endpoint,
      p256dh: target.p256dh,
      auth: target.auth,
      device_id: target.deviceId,
    });
  }

  return [...targets.values()].slice(0, 25);
}

export function upsertPeerTarget(
  list: PushTarget[],
  target: PushTarget,
  now = Date.now(),
): { list: PushTarget[]; isNew: boolean } {
  const cutoff = now - 60 * 24 * 60 * 60 * 1000;
  const fresh = list.filter((item) => item.seenAt >= cutoff);
  const isNew = !fresh.some(
    (item) => item.endpoint === target.endpoint || item.deviceId === target.deviceId,
  );
  const replaced = fresh.filter(
    (item) => item.endpoint !== target.endpoint && item.deviceId !== target.deviceId,
  );
  const updated = [...replaced, { ...target, seenAt: now }];
  updated.sort((a, b) => b.seenAt - a.seenAt);

  return { list: updated.slice(0, 20), isNew };
}

export function removeTargets(list: PushTarget[], endpoints: string[]): PushTarget[] {
  const removed = new Set(endpoints);
  return list.filter((target) => !removed.has(target.endpoint));
}
