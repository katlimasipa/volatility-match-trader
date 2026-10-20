/**
 * Cross-Device Notification & Audio Alert Manager
 * Supports Web Push, Service Worker notifications, iOS WebKit notifications, and audio alerts.
 */

const NOTIFICATION_PREF_KEY = 'thdpst_notifications_enabled';
const SOUND_PREF_KEY = 'thdpst_sound_enabled';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/**
 * Check if notifications are supported on current device / browser
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
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
 * Request notification permission from user / mobile browser
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) return 'unsupported';
  try {
    const res = await Notification.requestPermission();
    if (res === 'granted') {
      setNotificationEnabled(true);
    }
    return res as NotificationPermissionState;
  } catch (err) {
    console.warn('Failed to request notification permission:', err);
    return 'denied';
  }
}

/**
 * Play synthesizer audio cue using Web Audio API (works offline, zero asset downloads)
 */
export function playAlertSound(type: 'win' | 'loss' | 'alert') {
  if (!isSoundEnabled() || typeof window === 'undefined') return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
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

/**
 * Dispatch cross-device push / service worker notification with fallback
 */
export async function dispatchNotification(title: string, options: NotificationOptions = {}) {
  // Check vibration
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate([150, 60, 150]);
  }

  if (!isNotificationEnabled() || !isNotificationSupported() || Notification.permission !== 'granted') {
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
    // In some mobile contexts (e.g. mobile Chrome/iOS PWA), window Notification constructor may throw
  }
}

/**
 * Specific trade alerts
 */
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
