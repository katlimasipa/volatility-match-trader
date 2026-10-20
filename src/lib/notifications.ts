/**
 * Cross-Device Notification & Audio Alert Manager
 * Supports Web Push, Service Worker notifications, iOS PWA notifications, and audio alerts.
 *
 * iOS Notification Strategy:
 * - iOS Safari: No notification API at all — fall back to in-app visual + audio alerts
 * - iOS Standalone PWA (16.4+): Web Push supported, permission MUST come from direct user tap
 * - iOS < 16.4 Standalone: No notification support — fall back to in-app alerts
 * - All other browsers: Standard Notification API
 */

const NOTIFICATION_PREF_KEY = 'thdpst_notifications_enabled';
const SOUND_PREF_KEY = 'thdpst_sound_enabled';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

// ─── In-App Alert Banner System ───────────────────────────────────────────────
// For platforms where push notifications are unavailable (iOS Safari, old browsers)

type InAppAlertType = 'win' | 'loss' | 'info' | 'warning';

interface InAppAlert {
  id: number;
  title: string;
  body: string;
  type: InAppAlertType;
  timestamp: number;
}

let alertIdCounter = 0;
const inAppAlertListeners = new Set<(alert: InAppAlert) => void>();

export function onInAppAlert(callback: (alert: InAppAlert) => void): () => void {
  inAppAlertListeners.add(callback);
  return () => { inAppAlertListeners.delete(callback); };
}

function emitInAppAlert(title: string, body: string, type: InAppAlertType = 'info') {
  const alert: InAppAlert = {
    id: ++alertIdCounter,
    title,
    body,
    type,
    timestamp: Date.now(),
  };
  inAppAlertListeners.forEach((fn) => fn(alert));
}

// ─── Device & Platform Detection ──────────────────────────────────────────────

function _isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function _isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Check if the Notification API is available on current device / browser.
 * Returns false on iOS Safari (not installed as PWA).
 */
export function isNotificationSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'Notification' in window;
}

/**
 * Check if iOS Safari — notifications completely unavailable, must install PWA first.
 */
export function isIOSSafariNotPWA(): boolean {
  return _isIOS() && !_isStandalone();
}

/**
 * Check if running as iOS standalone PWA (16.4+ supports notifications)
 */
export function isIOSStandalonePWA(): boolean {
  return _isIOS() && _isStandalone();
}

/**
 * Returns the reason why notifications can't work, or null if they can.
 */
export function getNotificationBlockReason(): string | null {
  if (typeof window === 'undefined') return 'Not in browser';

  if (_isIOS() && !_isStandalone()) {
    return 'ios_safari';
  }

  if (_isIOS() && _isStandalone() && !('Notification' in window)) {
    return 'ios_old_version';
  }

  if (!('Notification' in window)) {
    return 'unsupported_browser';
  }

  if (Notification.permission === 'denied') {
    return 'denied';
  }

  return null;
}

/**
 * Get current notification permission
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/**
 * Check if user has toggled notifications ON
 */
export function isNotificationEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const pref = localStorage.getItem(NOTIFICATION_PREF_KEY);
  if (pref !== null) {
    return pref === 'true';
  }
  return isNotificationSupported() && Notification.permission === 'granted';
}

export function setNotificationEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(NOTIFICATION_PREF_KEY, String(enabled));
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const pref = localStorage.getItem(SOUND_PREF_KEY);
  return pref === null ? true : pref === 'true';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SOUND_PREF_KEY, String(enabled));
}

/**
 * Request notification permission from user.
 *
 * iOS PWA (16.4+): Uses callback-style API from direct tap gesture.
 * Desktop/Android: Standard promise-based API.
 * iOS Safari: Returns 'unsupported' — caller should show install guide instead.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined') return 'unsupported';

  // iOS Safari — no notification API at all
  if (_isIOS() && !_isStandalone()) {
    return 'unsupported';
  }

  if (!('Notification' in window)) {
    return 'unsupported';
  }

  // Already granted
  if (Notification.permission === 'granted') {
    setNotificationEnabled(true);
    return 'granted';
  }

  // Already denied
  if (Notification.permission === 'denied') {
    return 'denied';
  }

  try {
    // Use callback-style for iOS PWA compatibility (direct gesture context preserved)
    const result = await new Promise<NotificationPermission>((resolve) => {
      const maybePromise = Notification.requestPermission((permission) => {
        resolve(permission);
      });
      // Modern browsers return a Promise — handle both patterns
      if (maybePromise instanceof Promise) {
        maybePromise.then(resolve).catch(() => resolve('denied'));
      }
    });

    if (result === 'granted') {
      setNotificationEnabled(true);
    }
    return result as NotificationPermissionState;
  } catch (err) {
    console.warn('Failed to request notification permission:', err);
    return 'denied';
  }
}

// ─── Audio Alert System ───────────────────────────────────────────────────────

let sharedAudioContext: AudioContext | null = null;

/**
 * Initialize AudioContext from a user gesture (required on iOS/Safari).
 * Call this on the first user tap to ensure audio works.
 */
export function initAudioContext(): void {
  if (sharedAudioContext) return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      sharedAudioContext = new AudioContextClass();
      // Resume if suspended (iOS autoplay policy)
      if (sharedAudioContext.state === 'suspended') {
        sharedAudioContext.resume().catch(() => {});
      }
    }
  } catch {
    // Audio not available
  }
}

/**
 * Play synthesizer audio cue using Web Audio API (works offline, zero asset downloads)
 */
export function playAlertSound(type: 'win' | 'loss' | 'alert') {
  if (!isSoundEnabled() || typeof window === 'undefined') return;
  try {
    // Initialize shared context if needed (may fail without prior gesture on iOS)
    if (!sharedAudioContext) {
      initAudioContext();
    }
    if (!sharedAudioContext) return;

    // Resume if suspended
    if (sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }

    const ctx = sharedAudioContext;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'win') {
      // Pleasant rising arpeggio
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1); // E5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.2); // G5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'loss') {
      // Soft low descent
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.25);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else {
      // Clean chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    }
  } catch {
    // Audio context may be restricted by autoplay policy before user gesture
  }
}

// ─── Notification Dispatch ────────────────────────────────────────────────────

/**
 * Dispatch cross-device push / service worker notification with in-app fallback.
 * On platforms without push support, emits an in-app visual alert instead.
 */
export async function dispatchNotification(title: string, options: NotificationOptions = {}) {
  // Vibrate on supported devices
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate([150, 60, 150]);
  }

  // If push notifications aren't available or enabled, use in-app banner fallback
  if (!isNotificationEnabled() || !isNotificationSupported() || Notification.permission !== 'granted') {
    // Still emit in-app alert so user gets visual feedback
    const alertType: InAppAlertType =
      title.toLowerCase().includes('won') || title.toLowerCase().includes('profit') ? 'win' :
      title.toLowerCase().includes('lost') || title.toLowerCase().includes('loss') ? 'loss' :
      title.toLowerCase().includes('stop') ? 'warning' : 'info';
    emitInAppAlert(title, options.body || '', alertType);
    return;
  }

  const defaultOpts: NotificationOptions = {
    icon: '/app-icon.png',
    badge: '/favicon.png',
    tag: 'thdpst-matches-alert',
    ...options,
  };

  // Try service worker registration first (works in background on mobile & desktop)
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(title, defaultOpts);
        return;
      }
    } catch (e) {
      console.warn('Service worker notification failed, falling back to window Notification:', e);
    }
  }

  // Fallback to window Notification API
  try {
    new Notification(title, defaultOpts);
  } catch {
    // In some mobile contexts, window Notification constructor may throw
    emitInAppAlert(title, options.body || '', 'info');
  }
}

// ─── Specific Trade Alerts ────────────────────────────────────────────────────

export function notifyTradeWon(runIndex: number, pnl: number, target: number) {
  playAlertSound('win');
  dispatchNotification(`Trade Won: +$${pnl.toFixed(2)} USD`, {
    body: `Run #${runIndex} matched digit [${target}]. Profit added to balance.`,
    tag: `trade-win-${Date.now()}`,
  });
}

export function notifyTradeLost(runIndex: number, stake: number, result: number, target: number) {
  playAlertSound('loss');
  dispatchNotification(`Trade Lost: -$${stake.toFixed(2)} USD`, {
    body: `Run #${runIndex} exited with [${result}] (target was [${target}]).`,
    tag: `trade-loss-${Date.now()}`,
  });
}

export function notifyTakeProfit(totalPnl: number) {
  playAlertSound('win');
  dispatchNotification(`Take Profit Reached! (+$${totalPnl.toFixed(2)})`, {
    body: `Target profit achieved. Bot execution automatically stopped.`,
    tag: `tp-hit-${Date.now()}`,
  });
}

export function notifyStopLoss(totalPnl: number) {
  playAlertSound('loss');
  dispatchNotification(`Stop Loss Hit (-$${Math.abs(totalPnl).toFixed(2)})`, {
    body: `Risk limit reached. Bot execution stopped to protect capital.`,
    tag: `sl-hit-${Date.now()}`,
  });
}

export function notifyCycleCompleted(runCount: number, totalPnl: number) {
  playAlertSound('alert');
  dispatchNotification(`Cycle Completed (${runCount} Runs)`, {
    body: `Total Session Net: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} USD.`,
    tag: `cycle-completed-${Date.now()}`,
  });
}
