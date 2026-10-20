/**
 * Deriv Auth 2.0 (OAuth 2.0 + PKCE) Architecture
 * Implemented based on Deriv's official OAuth 2.0 PKCE specification.
 */

export interface AuthConfig {
  clientId: string;
  redirectUri: string;
  scopes?: string;
}

export interface AuthInfo {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  refresh_token?: string;
}

export interface DerivAccount {
  account_id: string; // e.g., 'VRTC123456' (Demo) or 'CR123456' (Real)
  account_type: 'demo' | 'real';
  currency: string;
  balance: string;
  status?: string;
}

export interface OTPResponse {
  data: {
    url: string;
  };
}

const STORAGE_KEYS = {
  APP_ID: 'deriv_app_id',
  CSRF_TOKEN: 'deriv_oauth_csrf',
  CODE_VERIFIER: 'deriv_oauth_code_verifier',
  REDIRECT_URI: 'deriv_oauth_redirect_uri',
  AUTH_INFO: 'deriv_auth_info',
  ACCOUNTS: 'deriv_accounts',
  ACTIVE_ACCOUNT_ID: 'deriv_active_account_id',
  ACTIVE_ACCOUNT_TYPE: 'deriv_active_account_type',
  MANUAL_TOKEN: 'deriv_manual_token',
} as const;

export const DERIV_ENDPOINTS = {
  authBase: 'https://auth.deriv.com/oauth2',
  apiBase: 'https://api.derivws.com/trading/v1/options',
  publicWs: 'wss://api.derivws.com/trading/v1/options/ws/public',
};

// Scopes matching Deriv Auth 2.0 portal for App ID
export const DEFAULT_DERIV_SCOPES = 'trade account_manage';

// Built-in App ID (never exposed to user inputs)
export const HARDCODED_APP_ID = '34JeA7thqzN4l0B8LCC6A';

/**
 * Generate cryptographically secure base64url string
 */
export function generateRandomBase64url(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Compute SHA-256 base64url hash for PKCE code_challenge
 */
export async function sha256Base64url(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Storage helpers
 */
export function getSavedAppId(): string {
  return HARDCODED_APP_ID;
}

export function setSavedAppId(appId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.APP_ID, appId.trim());
}

export function getStoredAuthInfo(): AuthInfo | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEYS.AUTH_INFO);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeAuthInfo(info: AuthInfo): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.AUTH_INFO, JSON.stringify(info));
}

export function getStoredAccounts(): DerivAccount[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function storeAccounts(accounts: DerivAccount[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(accounts));
}

export function getActiveAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
}

export function setActiveAccountId(accountId: string, explicitType?: 'demo' | 'real'): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, accountId);
  let type = explicitType;
  if (!type) {
    const stored = getStoredAccounts();
    const found = stored.find((a) => a.account_id === accountId);
    if (found) {
      type = found.account_type;
    } else {
      const isDemo =
        accountId.toUpperCase().startsWith('VRTC') ||
        accountId.toUpperCase().startsWith('V') ||
        accountId.toUpperCase().startsWith('DOT');
      type = isDemo ? 'demo' : 'real';
    }
  }
  localStorage.setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE, type);
}

export function getActiveAccountType(): 'demo' | 'real' {
  if (typeof window === 'undefined') return 'demo';
  return (localStorage.getItem(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE) as 'demo' | 'real') || 'demo';
}

export function getManualToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(STORAGE_KEYS.MANUAL_TOKEN) || '';
}

export function setManualToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.MANUAL_TOKEN, token.trim());
}

export function clearAllDerivAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.AUTH_INFO);
  localStorage.removeItem(STORAGE_KEYS.ACCOUNTS);
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE);
  localStorage.removeItem(STORAGE_KEYS.MANUAL_TOKEN);
  sessionStorage.removeItem(STORAGE_KEYS.CSRF_TOKEN);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEYS.REDIRECT_URI);
}

/**
 * Start Deriv Auth 2.0 PKCE Flow
 */
export async function startDerivAuth(config: AuthConfig): Promise<void> {
  const csrfToken = generateRandomBase64url(32);
  const codeVerifier = generateRandomBase64url(64);
  const codeChallenge = await sha256Base64url(codeVerifier);

  sessionStorage.setItem(STORAGE_KEYS.CSRF_TOKEN, csrfToken);
  sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);
  sessionStorage.setItem(STORAGE_KEYS.REDIRECT_URI, config.redirectUri);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId || HARDCODED_APP_ID,
    redirect_uri: config.redirectUri,
    scope: config.scopes || DEFAULT_DERIV_SCOPES,
    state: csrfToken,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${DERIV_ENDPOINTS.authBase}/auth?${params.toString()}`;
}

/**
 * Exchange Authorization Code for Access & Refresh Tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  state: string,
  clientId: string,
  redirectUri: string
): Promise<AuthInfo> {
  const storedCsrf = sessionStorage.getItem(STORAGE_KEYS.CSRF_TOKEN);
  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
  const effectiveRedirectUri = redirectUri || sessionStorage.getItem(STORAGE_KEYS.REDIRECT_URI) || '';

  sessionStorage.removeItem(STORAGE_KEYS.CSRF_TOKEN);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEYS.REDIRECT_URI);

  if (storedCsrf && storedCsrf !== state) {
    console.warn('CSRF token mismatch warning, continuing verification...');
  }

  if (!codeVerifier) {
    throw new Error('Code verifier expired or missing. Please try connecting again.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId || HARDCODED_APP_ID,
    code,
    redirect_uri: effectiveRedirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${DERIV_ENDPOINTS.authBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const authInfo: AuthInfo = {
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
    expires_in: data.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 7200),
    scope: data.scope,
    refresh_token: data.refresh_token,
  };

  storeAuthInfo(authInfo);
  return authInfo;
}

/**
 * Fetch accounts list from Deriv API
 */
export async function fetchDerivAccounts(authInfo: AuthInfo, clientId: string): Promise<DerivAccount[]> {
  const response = await fetch(`${DERIV_ENDPOINTS.apiBase}/accounts`, {
    headers: {
      Authorization: `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId || HARDCODED_APP_ID,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Deriv accounts (${response.status})`);
  }

  const json = await response.json();
  const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];

  const accounts: DerivAccount[] = rawList.map((acc: Record<string, unknown>) => {
    const id = String(acc.account_id || acc.loginid || '');
    const isDemo = id.toUpperCase().startsWith('VRTC') || id.toUpperCase().startsWith('V') || acc.account_type === 'demo';
    return {
      account_id: id,
      account_type: isDemo ? 'demo' : 'real',
      currency: String(acc.currency || 'USD'),
      balance: String(acc.balance || '0.00'),
      status: String(acc.status || 'active'),
    };
  });

  storeAccounts(accounts);

  // Default to first demo account if available
  const currentActive = getActiveAccountId();
  if (!currentActive || !accounts.some((a) => a.account_id === currentActive)) {
    const defaultAcc = accounts.find((a) => a.account_type === 'demo') || accounts[0];
    if (defaultAcc) {
      setActiveAccountId(defaultAcc.account_id);
    }
  }

  return accounts;
}

/**
 * Get One-Time Password URL for authenticated WebSocket session
 */
export async function getWebSocketOTP(
  accountId: string,
  authInfo: AuthInfo,
  clientId: string
): Promise<string> {
  const response = await fetch(`${DERIV_ENDPOINTS.apiBase}/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId || HARDCODED_APP_ID,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve WebSocket OTP (${response.status})`);
  }

  const data: OTPResponse = await response.json();
  return data.data.url;
}

/**
 * Automatically handle incoming OAuth callback parameters from current URL
 */
export async function handleIncomingOAuth(): Promise<{ handled: boolean; success: boolean; error?: string }> {
  if (typeof window === 'undefined') return { handled: false, success: false };

  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  const hash = url.hash.startsWith('#') ? url.hash.substring(1) : '';
  const hashParams = new URLSearchParams(hash);

  const error = searchParams.get('error') || hashParams.get('error');
  if (error) {
    const desc = searchParams.get('error_description') || hashParams.get('error_description') || error;
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
    return { handled: true, success: false, error: desc };
  }

  const code = searchParams.get('code') || hashParams.get('code');
  const state = searchParams.get('state') || hashParams.get('state') || '';

  if (code) {
    try {
      const storedRedirect = sessionStorage.getItem(STORAGE_KEYS.REDIRECT_URI) || `${window.location.origin}/`;
      const authInfo = await exchangeCodeForTokens(code, state, HARDCODED_APP_ID, storedRedirect);
      try {
        await fetchDerivAccounts(authInfo, HARDCODED_APP_ID);
      } catch (accErr) {
        console.warn('Account fetching note:', accErr);
      }
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
      return { handled: true, success: true };
    } catch (err) {
      window.history.replaceState({}, document.title, window.location.pathname);
      return { handled: true, success: false, error: err instanceof Error ? err.message : 'Token exchange failed' };
    }
  }

  // Check legacy OAuth tokens (acct1=...&token1=...)
  const legacyAccounts: DerivAccount[] = [];
  let i = 1;
  while (searchParams.get(`acct${i}`) || hashParams.get(`acct${i}`)) {
    const accId = searchParams.get(`acct${i}`) || hashParams.get(`acct${i}`) || '';
    const token = searchParams.get(`token${i}`) || hashParams.get(`token${i}`) || '';
    const cur = searchParams.get(`cur${i}`) || hashParams.get(`cur${i}`) || 'USD';
    if (accId) {
      const isDemo = accId.toUpperCase().startsWith('VRTC') || accId.toUpperCase().startsWith('V');
      legacyAccounts.push({
        account_id: accId,
        account_type: isDemo ? 'demo' : 'real',
        currency: cur,
        balance: '0.00',
      });
      if (token && (i === 1 || isDemo)) {
        setManualToken(token);
      }
    }
    i++;
  }

  if (legacyAccounts.length > 0) {
    storeAccounts(legacyAccounts);
    const demoAcc = legacyAccounts.find((a) => a.account_type === 'demo') || legacyAccounts[0];
    if (demoAcc) setActiveAccountId(demoAcc.account_id);
    window.history.replaceState({}, document.title, window.location.pathname);
    return { handled: true, success: true };
  }

  return { handled: false, success: false };
}
