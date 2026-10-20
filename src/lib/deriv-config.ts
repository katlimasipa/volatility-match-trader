// Deriv Auth 2.0 (OAuth 2.0 + PKCE). Docs: https://developers.deriv.com/docs/intro/oauth/
// Paste your new Deriv app ID (client_id) here, and register `${origin}/deriv/callback` as its redirect URI.
export const DERIV_CLIENT_ID: string = import.meta.env["VITE_DERIV_CLIENT_ID"] ?? "";
export const DERIV_AUTH_URL = "https://auth.deriv.com/oauth2/auth";
export const DERIV_SCOPES = "trade";

// Public tick stream (no account needed). 1089 is Deriv's public test app ID.
export const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";

export const derivRedirectUri = () => `${window.location.origin}/deriv/callback`;

const VERIFIER_KEY = "deriv_pkce_verifier";
const STATE_KEY = "deriv_oauth_state";

function randomString(len: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (v) => chars[v % chars.length]).join("");
}

async function challengeFor(verifier: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startDerivAuth(): Promise<void> {
  if (!DERIV_CLIENT_ID) throw new Error("Deriv app ID is not set yet.");
  const verifier = randomString(64);
  const state = randomString(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: DERIV_CLIENT_ID,
    redirect_uri: derivRedirectUri(),
    scope: DERIV_SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  window.location.href = `${DERIV_AUTH_URL}?${params}`;
}

/** Returns the stored verifier if the returned state matches, then clears both. */
export function consumePkce(returnedState: string | null): string | null {
  const state = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!state || !verifier || state !== returnedState) return null;
  return verifier;
}
