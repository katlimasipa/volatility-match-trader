/**
 * Deriv Auth 2.0 (OAuth 2.0 + PKCE) Architecture
 * Implemented based on Deriv's official OAuth 2.0 PKCE specification.
 */

export interface AuthConfig {
  clientId: string;
  redirectUri: string;
  scopes?: string; // defaults to 'read trade trading_information'
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
  AUTH_INFO: 'deriv_auth_info',
  ACCOUNTS: 'deriv_accounts',
  ACTIVE_ACCOUNT_ID: 'deriv_active_account_id',
  ACTIVE_ACCOUNT_TYPE: 'deriv_active_account_type',
  MANUAL_TOKEN: 'deriv_manual_token',
} as const;

export const DERIV_ENDPOINTS = {
  authBase: 'https://auth.deriv.com/oauth2',
  apiBase: 'https://api.derivws.com/trading/v1/options',
  publicWs: 'wss://ws.derivws.com/websockets/v3',
};

// Scopes matching Deriv Auth 2.0 app registration portal
export const DEFAULT_DERIV_SCOPES = 'trade account_manage';

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
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(STORAGE_KEYS.APP_ID) || import.meta.env.VITE_DERIV_CLIENT_ID || '';
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

export function setActiveAccountId(accountId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, accountId);
  const isDemo = accountId.toUpperCase().startsWith('VRTC') || accountId.toUpperCase().startsWith('V');
  localStorage.setItem(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE, isDemo ? 'demo' : 'real');
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

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
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

  sessionStorage.removeItem(STORAGE_KEYS.CSRF_TOKEN);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);

  if (!storedCsrf || storedCsrf !== state) {
    throw new Error('CSRF state verification failed — possible security interception.');
  }

  if (!codeVerifier) {
    throw new Error('Code verifier expired or missing. Please try logging in again.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
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
      'Deriv-App-ID': clientId,
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

  // If no active account set yet, default to first demo account or first account
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
      'Deriv-App-ID': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve WebSocket OTP (${response.status})`);
  }

  const data: OTPResponse = await response.json();
  return data.data.url;
}
