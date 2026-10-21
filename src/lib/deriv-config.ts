import { getSavedAppId, DEFAULT_DERIV_SCOPES } from './deriv-auth';

// Internal hardcoded Deriv App ID (invisible in UI)
export const DEFAULT_APP_ID = '34JeA7thqzN4l0B8LCC6A';

// Deriv Auth 2.0 (OAuth 2.0 + PKCE).
export const getDerivClientId = (): string => {
  return import.meta.env['VITE_DERIV_CLIENT_ID'] || getSavedAppId() || DEFAULT_APP_ID;
};

export const DERIV_AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
export const DERIV_SCOPES = DEFAULT_DERIV_SCOPES;

/**
 * Deriv App Markup Configuration by App ID:
 * When an App ID is registered on the Deriv Developer Portal, the developer specifies
 * an app_markup_percentage (e.g. 3.0%).
 * Deriv uses this App ID to automatically calculate contract payouts and deduct the developer's markup.
 */
export const REGISTERED_APP_MARKUPS: Record<string, number> = {
  '34JeA7thqzN4l0B8LCC6A': 3.0,
};

export function getAppIdMarkup(appId?: string): number {
  const id = appId || getDerivClientId();
  if (typeof window !== 'undefined' && id) {
    const custom = localStorage.getItem(`deriv_markup_${id}`);
    if (custom !== null) {
      const parsed = parseFloat(custom);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
  }
  if (import.meta.env['VITE_DERIV_APP_MARKUP']) {
    const envMarkup = parseFloat(import.meta.env['VITE_DERIV_APP_MARKUP']);
    if (!isNaN(envMarkup) && envMarkup >= 0) return envMarkup;
  }
  if (id && REGISTERED_APP_MARKUPS[id] !== undefined) {
    return REGISTERED_APP_MARKUPS[id];
  }
  return 3.0;
}

export function setAppIdMarkup(appId: string, markup: number): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`deriv_markup_${appId}`, String(markup));
}

// Live market tick stream using Deriv WebSocket endpoint with configured App ID
export const getDerivWsUrl = (appId?: string): string => {
  const id = appId || getDerivClientId();
  return id
    ? `wss://api.derivws.com/trading/v1/options/ws/public?app_id=${encodeURIComponent(id)}`
    : 'wss://api.derivws.com/trading/v1/options/ws/public';
};

export const DERIV_WS_URL = getDerivWsUrl();

/**
 * Deriv OAuth 2.0 Redirect URI
 * Must match the exact string registered in the Deriv developer portal (trailing slash matters).
 * Priority: local override → VITE_DERIV_REDIRECT_URI → production default.
 */
export const PRODUCTION_REDIRECT_URI = 'https://thdpstmatches.vercel.app/';

function withTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

export const derivRedirectUri = (): string => {
  if (typeof window !== 'undefined') {
    const override = localStorage.getItem('deriv_redirect_uri_override');
    if (override) return withTrailingSlash(override.trim());
  }
  const fromEnv = import.meta.env['VITE_DERIV_REDIRECT_URI'] as string | undefined;
  if (fromEnv && fromEnv.trim()) return withTrailingSlash(fromEnv.trim());
  return PRODUCTION_REDIRECT_URI;
};

/** True when the current origin can complete OAuth (registered redirect host). */
export const isOAuthOriginReady = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const redirect = new URL(derivRedirectUri());
    return redirect.origin === window.location.origin;
  } catch {
    return false;
  }
};

// Session storage helper for authenticated user
const USER_SESSION_KEY = 'v100_user_email';

export const session = {
  get: (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(USER_SESSION_KEY) || sessionStorage.getItem(USER_SESSION_KEY);
  },
  set: (email: string): void => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(USER_SESSION_KEY, email);
    sessionStorage.setItem(USER_SESSION_KEY, email);
  },
  clear: (): void => {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(USER_SESSION_KEY);
    sessionStorage.removeItem(USER_SESSION_KEY);
  },
};
