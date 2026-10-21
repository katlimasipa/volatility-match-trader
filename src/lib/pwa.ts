/**
 * PWA Registration, Lifecycle & Install Prompt Manager
 * Provides install prompt detection for Android/desktop and iOS installation guide.
 */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<(canInstall: boolean) => void>();

/**
 * Register Service Worker
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Check for updates periodically
        setInterval(() => {
          registration.update().catch(() => {});
        }, 60 * 60 * 1000); // 1 hour
      })
      .catch((error) => {
        console.warn('[PWA] ServiceWorker registration failed:', error);
      });
  };

  // Called from a React effect, which usually runs after `load` has already fired.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  // Listen for beforeinstallprompt event (Chrome, Edge, Android)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach((fn) => fn(true));
  });

  // Listen for appinstalled event
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installListeners.forEach((fn) => fn(false));
  });
}

/**
 * Check if the app is currently running in standalone PWA mode
 */
export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Check if device is iOS (iPhone/iPad/iPod)
 */
export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Check if install prompt is ready to trigger
 */
export function canInstallPWA(): boolean {
  return deferredPrompt !== null;
}

/**
 * Subscribe to installability changes
 */
export function onInstallableChange(callback: (canInstall: boolean) => void): () => void {
  installListeners.add(callback);
  callback(canInstallPWA());
  return () => {
    installListeners.delete(callback);
  };
}

/**
 * Trigger native install prompt
 */
export async function triggerInstallPrompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  try {
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    installListeners.forEach((fn) => fn(false));
    return choice.outcome;
  } catch (err) {
    console.warn('Install prompt error:', err);
    return 'unavailable';
  }
}
