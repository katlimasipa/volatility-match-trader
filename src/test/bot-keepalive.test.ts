import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  startAudioKeepalive,
  stopAudioKeepalive,
  requestScreenWakeLock,
  releaseScreenWakeLock,
  startWorkerHeartbeat,
  stopWorkerHeartbeat,
  startBotKeepalive,
  stopBotKeepalive,
} from "@/lib/bot-keepalive";

describe("Bot Keepalive Engine", () => {
  beforeEach(() => {
    stopBotKeepalive();
    vi.clearAllMocks();
  });

  it("safely handles audio keepalive when AudioContext is supported or not supported", () => {
    expect(() => startAudioKeepalive()).not.toThrow();
    expect(() => stopAudioKeepalive()).not.toThrow();
  });

  it("safely handles Screen Wake Lock requests without throwing", async () => {
    await expect(requestScreenWakeLock()).resolves.toBeUndefined();
    expect(() => releaseScreenWakeLock()).not.toThrow();
  });

  it("provides worker heartbeat fallback interval in environment without Web Worker", () => {
    vi.useFakeTimers();
    let ticks = 0;
    const cleanup = startWorkerHeartbeat(() => {
      ticks++;
    });

    vi.advanceTimersByTime(3000);
    expect(ticks).toBe(3);

    cleanup();
    vi.advanceTimersByTime(2000);
    expect(ticks).toBe(3);
    vi.useRealTimers();
  });

  it("coordinates startBotKeepalive and stopBotKeepalive without errors", () => {
    const cleanup = startBotKeepalive(() => {});
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
    expect(() => stopBotKeepalive()).not.toThrow();
  });
});
