import { describe, expect, it } from "vitest";
import {
  mergePushTargets,
  removeTargets,
  upsertPeerTarget,
  type PushTarget,
} from "@/lib/push-targets";

const DAY = 24 * 60 * 60 * 1000;

function peer(
  deviceId: string,
  endpoint = `https://push.example/${deviceId}`,
  seenAt = 1,
): PushTarget {
  return {
    endpoint,
    p256dh: `key-${deviceId}`,
    auth: `auth-${deviceId}`,
    deviceId,
    seenAt,
  };
}

describe("push target merging", () => {
  it("deduplicates endpoints with database rows taking precedence", () => {
    const merged = mergePushTargets(
      [
        {
          endpoint: "https://push.example/shared",
          p256dh: "db-key",
          auth: "db-auth",
          device_id: "db-device",
        },
      ],
      [
        {
          endpoint: "https://push.example/shared",
          p256dh: "peer-key",
          auth: "peer-auth",
          deviceId: "peer-device",
        },
        {
          endpoint: "https://push.example/peer",
          p256dh: "peer-key",
          auth: "peer-auth",
          deviceId: "peer-device",
        },
      ],
    );

    expect(merged).toEqual([
      {
        endpoint: "https://push.example/shared",
        p256dh: "db-key",
        auth: "db-auth",
        device_id: "db-device",
      },
      {
        endpoint: "https://push.example/peer",
        p256dh: "peer-key",
        auth: "peer-auth",
        device_id: "peer-device",
      },
    ]);
  });

  it("excludes targets from the source device", () => {
    const merged = mergePushTargets(
      [
        {
          endpoint: "https://push.example/self",
          p256dh: "key",
          auth: "auth",
          device_id: "source",
        },
      ],
      [
        {
          endpoint: "https://push.example/self-provided",
          p256dh: "key",
          auth: "auth",
          deviceId: "source",
        },
        {
          endpoint: "https://push.example/peer",
          p256dh: "key",
          auth: "auth",
          deviceId: "peer",
        },
      ],
      "source",
    );

    expect(merged.map((target) => target.endpoint)).toEqual(["https://push.example/peer"]);
  });

  it("rejects endpoints that are not valid HTTPS URLs", () => {
    const merged = mergePushTargets(
      [
        {
          endpoint: "http://push.example/insecure",
          p256dh: "key",
          auth: "auth",
          device_id: "db",
        },
      ],
      [
        {
          endpoint: "not-a-url",
          p256dh: "key",
          auth: "auth",
          deviceId: "peer",
        },
      ],
    );

    expect(merged).toEqual([]);
  });

  it("caps merged targets at 25", () => {
    const merged = mergePushTargets(
      [],
      Array.from({ length: 30 }, (_, index) => ({
        endpoint: `https://push.example/${index}`,
        p256dh: "key",
        auth: "auth",
        deviceId: `device-${index}`,
      })),
    );

    expect(merged).toHaveLength(25);
  });
});

describe("peer push target cache", () => {
  it("reports new peers and avoids treating known endpoints as new", () => {
    const first = upsertPeerTarget([], peer("phone"), 100);
    const existing = upsertPeerTarget(first.list, peer("phone"), 200);

    expect(first.isNew).toBe(true);
    expect(existing.isNew).toBe(false);
    expect(existing.list).toHaveLength(1);
    expect(existing.list[0]?.seenAt).toBe(200);
  });

  it("replaces an old endpoint when the same device resubscribes", () => {
    const oldTarget = peer("phone", "https://push.example/old");
    const result = upsertPeerTarget([oldTarget], peer("phone", "https://push.example/new"), 200);

    expect(result.isNew).toBe(false);
    expect(result.list).toEqual([peer("phone", "https://push.example/new", 200)]);
  });

  it("drops entries older than 60 days", () => {
    const now = 100 * DAY;
    const result = upsertPeerTarget(
      [peer("expired", "https://push.example/expired", now - 60 * DAY - 1)],
      peer("new", "https://push.example/new"),
      now,
    );

    expect(result.list.map((target) => target.deviceId)).toEqual(["new"]);
    expect(result.isNew).toBe(true);
  });

  it("keeps the 20 newest peers", () => {
    const now = 100 * DAY;
    const existing = Array.from({ length: 20 }, (_, index) =>
      peer(`device-${index}`, `https://push.example/${index}`, now - index),
    );
    const result = upsertPeerTarget(existing, peer("new", "https://push.example/new"), now + 1);

    expect(result.list).toHaveLength(20);
    expect(result.list[0]?.deviceId).toBe("new");
    expect(result.list.some((target) => target.deviceId === "device-19")).toBe(false);
  });

  it("removes stale endpoints", () => {
    const targets = [peer("one"), peer("two")];

    expect(removeTargets(targets, [targets[0]!.endpoint])).toEqual([targets[1]]);
  });
});
