/**
 * Deriv Auth 2.0 (OAuth 2.0 + PKCE) & Direct Token Architecture
 * Supports Web, Mobile, and Standalone PWA (iOS / Android) authentication.
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
  APP_MARKUP: 'deriv_app_markup',
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
  publicWs: 'wss://ws.derivws.com/websockets/v3',
};

// Scopes matching Deriv Auth 2.0 portal for App ID
export const DEFAULT_DERIV_SCOPES = 'trade account_manage';

// Built-in App ID (never exposed in UI)
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
 * Dual-write helpers so Auth 2.0 survives PWA reloads and Safari ITP quirks.
 * iOS home-screen apps still cannot share storage with Safari after OAuth —
 * for those, paste an API / Auth 2.0 token instead.
 */
function readDual(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  } catch {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

function writeDual(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {}
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

function removeDual(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {}
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

/** True when OAuth redirect cannot return into this app shell (iOS installed PWA). */
export function isStandaloneIosPwa(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const ua = window.navigator.userAgent.toLowerCase();
  const ios =
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return standalone && ios;
}

/**
 * Storage helpers (using both localStorage and sessionStorage for PWA persistence)
 */
export function getSavedAppId(): string {
  if (typeof window === 'undefined') return HARDCODED_APP_ID;
  return localStorage.getItem(STORAGE_KEYS.APP_ID) || import.meta.env['VITE_DERIV_CLIENT_ID'] || HARDCODED_APP_ID;
}

export function setSavedAppId(appId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.APP_ID, appId.trim());
}

export function getStoredAuthInfo(): AuthInfo | null {
  if (typeof window === 'undefined') return null;
  const raw = readDual(STORAGE_KEYS.AUTH_INFO);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthInfo;
    // Re-hydrate both stores if only one had it (PWA / Safari edge cases)
    writeDual(STORAGE_KEYS.AUTH_INFO, raw);
    return parsed;
  } catch {
    return null;
  }
}

export function storeAuthInfo(info: AuthInfo): void {
  if (typeof window === 'undefined') return;
  writeDual(STORAGE_KEYS.AUTH_INFO, JSON.stringify(info));
}

export function getStoredAccounts(): DerivAccount[] {
  if (typeof window === 'undefined') return [];
  const raw = readDual(STORAGE_KEYS.ACCOUNTS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DerivAccount[];
    writeDual(STORAGE_KEYS.ACCOUNTS, raw);
    return parsed;
  } catch {
    return [];
  }
}

export function storeAccounts(accounts: DerivAccount[]): void {
  if (typeof window === 'undefined') return;
  writeDual(STORAGE_KEYS.ACCOUNTS, JSON.stringify(accounts));
}

export function getActiveAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  return readDual(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
}

export function setActiveAccountId(accountId: string, explicitType?: 'demo' | 'real'): void {
  if (typeof window === 'undefined') return;
  writeDual(STORAGE_KEYS.ACTIVE_ACCOUNT_ID, accountId);
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
        accountId.toUpperCase().startsWith('DOT') ||
        accountId.toUpperCase().startsWith('VRW');
      type = isDemo ? 'demo' : 'real';
    }
  }
  writeDual(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE, type);
}

export function getActiveAccountType(): 'demo' | 'real' {
  if (typeof window === 'undefined') return 'demo';
  return (readDual(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE) as 'demo' | 'real') || 'demo';
}

export function getManualToken(): string {
  if (typeof window === 'undefined') return '';
  return readDual(STORAGE_KEYS.MANUAL_TOKEN) || '';
}

export function setManualToken(token: string): void {
  if (typeof window === 'undefined') return;
  writeDual(STORAGE_KEYS.MANUAL_TOKEN, token.trim());
}

export function clearAllDerivAuth(): void {
  if (typeof window === 'undefined') return;
  removeDual(STORAGE_KEYS.AUTH_INFO);
  removeDual(STORAGE_KEYS.MANUAL_TOKEN);
  removeDual(STORAGE_KEYS.CSRF_TOKEN);
  removeDual(STORAGE_KEYS.CODE_VERIFIER);
  removeDual(STORAGE_KEYS.REDIRECT_URI);
  removeDual(STORAGE_KEYS.ACCOUNTS);
  removeDual(STORAGE_KEYS.ACTIVE_ACCOUNT_ID);
  removeDual(STORAGE_KEYS.ACTIVE_ACCOUNT_TYPE);
}

/**
 * Start Deriv Auth 2.0 PKCE Flow
 * Stores verifier in state parameter so it survives mobile browsers, iOS PWA cross-domain redirects,
 * and Safari ITP tracking protection with 100% reliability.
 */
export async function startDerivAuth(config: AuthConfig): Promise<void> {
  const csrfToken = generateRandomBase64url(24);
  const codeVerifier = generateRandomBase64url(48);
  const codeChallenge = await sha256Base64url(codeVerifier);

  // Encode verifier into state so it survives PWA / cross-domain redirects
  const combinedState = `${csrfToken}.${codeVerifier}`;

  writeDual(STORAGE_KEYS.CSRF_TOKEN, csrfToken);
  writeDual(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);
  writeDual(STORAGE_KEYS.REDIRECT_URI, config.redirectUri);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId || HARDCODED_APP_ID,
    redirect_uri: config.redirectUri,
    scope: config.scopes || DEFAULT_DERIV_SCOPES,
    state: combinedState,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
  });

  // Same-document navigation keeps Android / desktop PWA session storage
  window.location.assign(`${DERIV_ENDPOINTS.authBase}/auth?${params.toString()}`);
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
  // 1. Recover verifier from state payload if available (bulletproof cross-domain/PWA support)
  let codeVerifierFromState = '';
  if (state && state.includes('.')) {
    const parts = state.split('.');
    const verifierPart = parts[1];
    if (parts.length >= 2 && verifierPart && verifierPart.length >= 30) {
      codeVerifierFromState = verifierPart;
    }
  }

  const codeVerifier =
    codeVerifierFromState || readDual(STORAGE_KEYS.CODE_VERIFIER) || '';

  // Deriv requires the exact registered redirect URI used in the first request
  const effectiveRedirectUri =
    redirectUri ||
    readDual(STORAGE_KEYS.REDIRECT_URI) ||
    (typeof import.meta !== 'undefined' && import.meta.env?.['VITE_DERIV_REDIRECT_URI']) ||
    'https://thdpstmatches.vercel.app/';

  removeDual(STORAGE_KEYS.CSRF_TOKEN);
  removeDual(STORAGE_KEYS.CODE_VERIFIER);
  removeDual(STORAGE_KEYS.REDIRECT_URI);

  if (!codeVerifier) {
    throw new Error('Login session expired. Sign in again, or paste an API token.');
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
  if (data.access_token) {
    setManualToken(data.access_token);
  }
  return authInfo;
}

/**
 * Classic Binary API tokens are short opaque strings.
 * Auth 2.0 OAuth / PAT tokens are JWTs (three base64 segments) or longer bearer tokens.
 */
export function looksLikeClassicApiToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  // JWT shape: header.payload.signature
  if (t.split('.').length === 3 && t.length > 80) return false;
  // Auth 2.0 PAT / opaque tokens from the new portal are often longer
  if (t.length > 60 && !/^[a-zA-Z0-9]{10,40}$/.test(t)) return false;
  return true;
}

function mapOptionsAccountRow(row: Record<string, unknown>): DerivAccount | null {
  const id = String(
    row['account_id'] || row['accountId'] || row['loginid'] || row['id'] || ''
  ).trim();
  if (!id) return null;

  const typeRaw = String(row['account_type'] || row['accountType'] || row['type'] || '').toLowerCase();
  const isDemo =
    typeRaw === 'demo' ||
    typeRaw === 'virtual' ||
    Boolean(row['is_virtual']) ||
    Boolean(row['is_demo']) ||
    id.toUpperCase().startsWith('VRTC') ||
    id.toUpperCase().startsWith('V') ||
    id.toUpperCase().startsWith('DOT') ||
    id.toUpperCase().startsWith('VRW');

  const balanceRaw = row['balance'] ?? row['available_balance'] ?? row['amount'] ?? 0;
  const currency = String(row['currency'] || row['currency_code'] || 'USD');

  return {
    account_id: id,
    account_type: isDemo ? 'demo' : 'real',
    currency,
    balance: Number(balanceRaw || 0).toFixed(2),
    status: row['is_disabled'] || row['status'] === 'disabled' ? 'disabled' : 'active',
  };
}

/**
 * Auth 2.0 REST: list Options trading accounts (demo + real) with live balances.
 */
export async function fetchOptionsAccountsViaRest(
  token: string,
  appId: string = HARDCODED_APP_ID
): Promise<{ success: boolean; accounts: DerivAccount[]; error?: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { success: false, accounts: [], error: 'Token cannot be empty.' };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    };
    if (appId) headers['Deriv-App-ID'] = appId;

    const response = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        accounts: [],
        error: `Accounts request failed (${response.status}): ${text || response.statusText}`,
      };
    }

    const payload = (await response.json()) as
      | { data?: unknown }
      | unknown[]
      | Record<string, unknown>;

    let rows: Record<string, unknown>[] = [];
    if (Array.isArray(payload)) {
      rows = payload as Record<string, unknown>[];
    } else if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      const data = obj['data'];
      if (Array.isArray(data)) {
        rows = data as Record<string, unknown>[];
      } else if (data && typeof data === 'object' && Array.isArray((data as { accounts?: unknown }).accounts)) {
        rows = (data as { accounts: Record<string, unknown>[] }).accounts;
      } else if (Array.isArray(obj['accounts'])) {
        rows = obj['accounts'] as Record<string, unknown>[];
      }
    }

    const accounts = rows
      .map(mapOptionsAccountRow)
      .filter((a): a is DerivAccount => Boolean(a?.account_id));

    if (accounts.length === 0) {
      return {
        success: false,
        accounts: [],
        error: 'No Options trading accounts returned. Create a demo account in Deriv, then reconnect.',
      };
    }

    storeAccounts(accounts);
    setManualToken(cleanToken);

    const preferred =
      accounts.find((a) => a.account_id === getActiveAccountId()) ||
      accounts.find((a) => a.account_type === 'demo') ||
      accounts[0];
    if (preferred) {
      setActiveAccountId(preferred.account_id, preferred.account_type);
    }

    return { success: true, accounts };
  } catch (err) {
    return {
      success: false,
      accounts: [],
      error: err instanceof Error ? err.message : 'Failed to load Deriv accounts.',
    };
  }
}

/**
 * Refresh Auth 2.0 access token using the stored refresh_token.
 */
export async function refreshAccessToken(
  clientId: string = HARDCODED_APP_ID
): Promise<AuthInfo | null> {
  const current = getStoredAuthInfo();
  if (!current?.refresh_token) return null;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId || HARDCODED_APP_ID,
      refresh_token: current.refresh_token,
    });

    const response = await fetch(`${DERIV_ENDPOINTS.authBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const authInfo: AuthInfo = {
      access_token: data.access_token,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      scope: data.scope || current.scope,
      refresh_token: data.refresh_token || current.refresh_token,
    };
    storeAuthInfo(authInfo);
    if (authInfo.access_token) setManualToken(authInfo.access_token);
    return authInfo;
  } catch {
    return null;
  }
}

async function authorizeClassicWs(token: string): Promise<{
  success: boolean;
  accounts: DerivAccount[];
  activeAccount?: DerivAccount | undefined;
  error?: string;
}> {
  const cleanToken = token.trim();
  const appIds = ['1089', HARDCODED_APP_ID].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

  for (const appId of appIds) {
    const result = await new Promise<{
      success: boolean;
      accounts: DerivAccount[];
      activeAccount?: DerivAccount | undefined;
      error?: string;
    }>((resolve) => {
      try {
        const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(
          /^\d+$/.test(appId) ? appId : '1089'
        )}`;
        const ws = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve({
            success: false,
            accounts: [],
            error: 'Connection to Deriv timed out. Please check your network and try again.',
          });
        }, 12000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ authorize: cleanToken }));
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {}
          resolve({
            success: false,
            accounts: [],
            error: 'Unable to connect to Deriv API servers.',
          });
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.error) {
              clearTimeout(timeout);
              try {
                ws.close();
              } catch {}
              resolve({
                success: false,
                accounts: [],
                error: data.error.message || 'Deriv rejected the token. Please verify permissions.',
              });
              return;
            }

            if (data.msg_type === 'authorize' && data.authorize) {
              clearTimeout(timeout);
              const auth = data.authorize;
              const rawList: Record<string, unknown>[] = Array.isArray(auth.account_list)
                ? auth.account_list
                : [];

              let accounts: DerivAccount[] = rawList.map((acc: Record<string, unknown>) => {
                const id = String(acc['loginid'] || '');
                const isDemo =
                  id.toUpperCase().startsWith('VRTC') ||
                  id.toUpperCase().startsWith('V') ||
                  Boolean(acc['is_virtual']);
                return {
                  account_id: id,
                  account_type: (isDemo ? 'demo' : 'real') as 'demo' | 'real',
                  currency: String(acc['currency'] || 'USD'),
                  balance: id === auth.loginid ? Number(auth.balance || 0).toFixed(2) : '0.00',
                  status: acc['is_disabled'] ? 'disabled' : 'active',
                };
              });

              if (auth.loginid) {
                const currentId = String(auth.loginid);
                const exists = accounts.find((a) => a.account_id === currentId);
                if (exists) {
                  exists.balance = Number(auth.balance || 0).toFixed(2);
                  exists.currency = String(auth.currency || exists.currency);
                } else {
                  const isDemo = currentId.toUpperCase().startsWith('VRTC');
                  accounts.unshift({
                    account_id: currentId,
                    account_type: isDemo ? 'demo' : 'real',
                    currency: String(auth.currency || 'USD'),
                    balance: Number(auth.balance || 0).toFixed(2),
                    status: 'active',
                  });
                }
              }

              accounts = accounts.filter((a) => Boolean(a.account_id));
              storeAccounts(accounts);
              setManualToken(cleanToken);

              const activeAcc = accounts.find((a) => a.account_id === auth.loginid) || accounts[0];
              if (activeAcc) {
                setActiveAccountId(activeAcc.account_id, activeAcc.account_type);
              }

              storeAuthInfo({
                access_token: cleanToken,
                token_type: 'Bearer',
                expires_in: 86400,
                expires_at: Math.floor(Date.now() / 1000) + 86400,
                scope: 'trade account_manage',
              });

              try {
                ws.close();
              } catch {}
              resolve({ success: true, accounts, activeAccount: activeAcc });
            }
          } catch {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {}
            resolve({
              success: false,
              accounts: [],
              error: 'Failed to process authorization response from Deriv.',
            });
          }
        };
      } catch (err) {
        resolve({
          success: false,
          accounts: [],
          error: err instanceof Error ? err.message : 'Unknown authorization error.',
        });
      }
    });

    if (result.success) return result;
  }

  return {
    success: false,
    accounts: [],
    error: 'Classic authorize failed for this token.',
  };
}

/**
 * Direct Deriv Token Authorization.
 * - Classic API tokens → Binary WebSocket authorize
 * - Auth 2.0 OAuth / PAT → REST Options accounts (+ optional classic fallback)
 * Works on iOS PWA, Android, Web, and Desktop.
 */
export async function authorizeWithToken(token: string): Promise<{
  success: boolean;
  accounts: DerivAccount[];
  activeAccount?: DerivAccount | undefined;
  error?: string;
}> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { success: false, accounts: [], error: 'Token cannot be empty.' };
  }

  // Prefer Auth 2.0 REST for non-classic tokens (OAuth JWT / PAT)
  if (!looksLikeClassicApiToken(cleanToken)) {
    const rest = await fetchOptionsAccountsViaRest(cleanToken);
    if (rest.success && rest.accounts.length > 0) {
      storeAuthInfo({
        access_token: cleanToken,
        token_type: 'Bearer',
        expires_in: 7200,
        expires_at: Math.floor(Date.now() / 1000) + 7200,
        scope: 'trade account_manage',
        refresh_token: getStoredAuthInfo()?.refresh_token,
      });
      const active =
        rest.accounts.find((a) => a.account_id === getActiveAccountId()) ||
        rest.accounts.find((a) => a.account_type === 'demo') ||
        rest.accounts[0];
      return { success: true, accounts: rest.accounts, activeAccount: active };
    }

    // Token may have expired — try refresh then REST again
    const refreshed = await refreshAccessToken();
    if (refreshed?.access_token) {
      const again = await fetchOptionsAccountsViaRest(refreshed.access_token);
      if (again.success && again.accounts.length > 0) {
        const active =
          again.accounts.find((a) => a.account_id === getActiveAccountId()) ||
          again.accounts.find((a) => a.account_type === 'demo') ||
          again.accounts[0];
        return { success: true, accounts: again.accounts, activeAccount: active };
      }
    }

    // Fall through to classic in case the token is still a legacy API token
  }

  const classic = await authorizeClassicWs(cleanToken);
  if (classic.success) return classic;

  // Last resort: Auth 2.0 REST for tokens that looked classic but weren't
  const restFallback = await fetchOptionsAccountsViaRest(cleanToken);
  if (restFallback.success && restFallback.accounts.length > 0) {
    storeAuthInfo({
      access_token: cleanToken,
      token_type: 'Bearer',
      expires_in: 7200,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      scope: 'trade account_manage',
    });
    const active =
      restFallback.accounts.find((a) => a.account_id === getActiveAccountId()) ||
      restFallback.accounts.find((a) => a.account_type === 'demo') ||
      restFallback.accounts[0];
    return { success: true, accounts: restFallback.accounts, activeAccount: active };
  }

  return {
    success: false,
    accounts: [],
    error:
      classic.error ||
      restFallback.error ||
      'Could not authorize this token. Use Deriv Auth 2.0 or an API token with Read + Trade.',
  };
}

/**
 * Fetch accounts list from Deriv Auth 2.0 REST and/or classic WebSocket.
 */
export async function fetchDerivAccounts(authInfo: AuthInfo, _clientId: string): Promise<DerivAccount[]> {
  const token = authInfo.access_token || getManualToken();
  if (!token) {
    return getStoredAccounts();
  }

  const result = await authorizeWithToken(token);
  if (result.success && result.accounts.length > 0) {
    return result.accounts;
  }
  return getStoredAccounts();
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
    window.history.replaceState({}, document.title, window.location.pathname);
    return { handled: true, success: false, error: desc };
  }

  // 1. Check legacy / token parameters (token1=..., acct1=...)
  const legacyAccounts: DerivAccount[] = [];
  let i = 1;
  let primaryToken = '';
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
      if (token && (!primaryToken || isDemo)) {
        primaryToken = token;
        setManualToken(token);
      }
    }
    i++;
  }

  if (legacyAccounts.length > 0) {
    storeAccounts(legacyAccounts);
    const demoAcc = legacyAccounts.find((a) => a.account_type === 'demo') || legacyAccounts[0];
    if (demoAcc) setActiveAccountId(demoAcc.account_id);

    // If we received tokens, verify and fetch actual live balances
    if (primaryToken) {
      try {
        await authorizeWithToken(primaryToken);
      } catch {}
    }

    window.history.replaceState({}, document.title, window.location.pathname);
    return { handled: true, success: true };
  }

  // 2. Check for PKCE Authorization Code
  const code = searchParams.get('code') || hashParams.get('code');
  const state = searchParams.get('state') || hashParams.get('state') || '';

  if (code) {
    try {
      const clientId =
        (typeof import.meta !== 'undefined' && import.meta.env?.['VITE_DERIV_CLIENT_ID']) ||
        getSavedAppId() ||
        HARDCODED_APP_ID;
      const storedRedirect =
        readDual(STORAGE_KEYS.REDIRECT_URI) ||
        (typeof import.meta !== 'undefined' && import.meta.env?.['VITE_DERIV_REDIRECT_URI']) ||
        'https://thdpstmatches.vercel.app/';
      const authInfo = await exchangeCodeForTokens(code, state, clientId, storedRedirect);
      try {
        if (authInfo.access_token) {
          await authorizeWithToken(authInfo.access_token);
        } else {
          await fetchDerivAccounts(authInfo, clientId);
        }
      } catch (accErr) {
        console.warn('Account fetching note:', accErr);
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      return { handled: true, success: true };
    } catch (err) {
      window.history.replaceState({}, document.title, window.location.pathname);
      return {
        handled: true,
        success: false,
        error: err instanceof Error ? err.message : 'Token exchange failed',
      };
    }
  }

  return { handled: false, success: false };
}
