import { getSavedAppId, setSavedAppId, DEFAULT_DERIV_SCOPES } from './deriv-auth';

export const DEFAULT_APP_ID = '34JeA7thqzN4l0B8LCC6A';

// Deriv Auth 2.0 (OAuth 2.0 + PKCE).
export const getDerivClientId = (): string => {
  return getSavedAppId() || import.meta.env.VITE_DERIV_CLIENT_ID || DEFAULT_APP_ID;
};

export const setDerivClientId = (id: string): void => {
  setSavedAppId(id);
};

export const DERIV_AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
export const DERIV_SCOPES = DEFAULT_DERIV_SCOPES;

// Live tick stream using user's App ID
export const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DEFAULT_APP_ID}`;

export const derivRedirectUri = (): string => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/deriv/callback`;
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
