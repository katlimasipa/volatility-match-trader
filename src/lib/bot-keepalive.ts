/**
 * Desktop PWA & Background Tab Keepalive Engine
 * Prevents browser tab freezing, sleeping tabs, memory discarding,
 * and timer throttling when the user leaves the tab, minimizes the PWA,
 * or switches to another desktop application.
 */

interface AudioKeepaliveHandle {
  ctx: AudioContext;
  osc: OscillatorNode;
  gain: GainNode;
}

let activeAudioHandle: AudioKeepaliveHandle | null = null;
let activeWakeLock: WakeLockSentinel | null = null;
let activeWorker: Worker | null = null;

/**
 * Start inaudible Web Audio playback.
 * Browsers (Chrome, Edge, Safari, Firefox) classify tabs with active audio streams
 * as "Active Media Playback Tabs", which gives them 100% exemption from:
 * - Sleeping tabs / Memory Saver discarding
 * - Background intensive timer throttling
 * - Thread suspension
 */
export function startAudioKeepalive(): void {
  if (typeof window === "undefined") return;
  if (activeAudioHandle) return;

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // 440 Hz at gain 0.00001 (completely imperceptible/inaudible, but keeps the audio subsystem actively streaming)
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    gain.gain.setValueAtTime(0.00001, ctx.currentTime);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    activeAudioHandle = { ctx, osc, gain };
  } catch (err) {
    console.warn("[keepalive] Audio keepalive failed to start:", err);
  }
}

/**
 * Stop inaudible Web Audio keepalive.
 */
export function stopAudioKeepalive(): void {
  if (!activeAudioHandle) return;
  try {
    activeAudioHandle.osc.stop();
    activeAudioHandle.osc.disconnect();
    activeAudioHandle.gain.disconnect();
    activeAudioHandle.ctx.close().catch(() => {});
  } catch {}
  activeAudioHandle = null;
}

/**
 * Request Screen Wake Lock to prevent the desktop or mobile OS from sleeping the display/system.
 */
export async function requestScreenWakeLock(): Promise<void> {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  if (activeWakeLock && !activeWakeLock.released) return;

  try {
    activeWakeLock = await navigator.wakeLock.request("screen");
    activeWakeLock.addEventListener("release", () => {
      activeWakeLock = null;
    });
  } catch (err) {
    console.warn("[keepalive] Screen Wake Lock not granted:", err);
  }
}

/**
 * Release Screen Wake Lock.
 */
export function releaseScreenWakeLock(): void {
  if (activeWakeLock) {
    try {
      activeWakeLock.release().catch(() => {});
    } catch {}
    activeWakeLock = null;
  }
}

/**
 * Background Web Worker Heartbeat.
 * Standard `setInterval` inside main window threads gets throttled down to once per minute
 * after 5 minutes in a background tab by Chromium's Intensive Throttling policy.
 * Web Worker intervals are completely exempt from 1-minute throttling.
 */
export function startWorkerHeartbeat(onTick: () => void): () => void {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    const id = setInterval(onTick, 1000);
    return () => clearInterval(id);
  }

  stopWorkerHeartbeat();

  try {
    const workerBlob = new Blob(
      [
        `
        var intervalId = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (intervalId) clearInterval(intervalId);
            intervalId = setInterval(function() {
              self.postMessage('heartbeat');
            }, 1000);
          } else if (e.data === 'stop') {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
          }
        };
      `,
      ],
      { type: "application/javascript" },
    );

    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);

    worker.onmessage = (e) => {
      if (e.data === "heartbeat") {
        onTick();
      }
    };

    worker.postMessage("start");
    activeWorker = worker;

    return () => {
      stopWorkerHeartbeat();
      URL.revokeObjectURL(workerUrl);
    };
  } catch (err) {
    console.warn("[keepalive] Web Worker keepalive failed, using fallback interval:", err);
    const id = setInterval(onTick, 1000);
    return () => clearInterval(id);
  }
}

/**
 * Stop Web Worker heartbeat.
 */
export function stopWorkerHeartbeat(): void {
  if (activeWorker) {
    try {
      activeWorker.postMessage("stop");
      activeWorker.terminate();
    } catch {}
    activeWorker = null;
  }
}

/**
 * Start full background keepalive shield (Audio + WakeLock + Worker).
 */
export function startBotKeepalive(onHeartbeat?: () => void): () => void {
  startAudioKeepalive();
  void requestScreenWakeLock();
  let cleanupWorker: (() => void) | null = null;
  if (onHeartbeat) {
    cleanupWorker = startWorkerHeartbeat(onHeartbeat);
  }
  return () => {
    stopAudioKeepalive();
    releaseScreenWakeLock();
    cleanupWorker?.();
  };
}

/**
 * Stop full background keepalive shield.
 */
export function stopBotKeepalive(): void {
  stopAudioKeepalive();
  releaseScreenWakeLock();
  stopWorkerHeartbeat();
}
