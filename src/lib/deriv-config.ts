// Deriv connection config. Replace VITE_DERIV_APP_ID with your new Deriv app ID when ready.
// 1089 is Deriv's public test app ID, used here only for the public tick stream.
export const DERIV_APP_ID: string = import.meta.env.VITE_DERIV_APP_ID ?? "1089";
export const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

// Placeholder for Deriv Auth 2.0 (OAuth). Wire this up once the app ID and redirect URL exist.
export function startDerivAuth(): void {
  throw new Error("Deriv Auth is not connected yet.");
}

const SESSION_KEY = "vmatch.session";
export const session = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(SESSION_KEY)),
  set: (email: string) => window.localStorage.setItem(SESSION_KEY, email),
  clear: () => window.localStorage.removeItem(SESSION_KEY),
};
