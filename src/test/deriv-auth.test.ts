import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStoredAuthInfo,
  hasUsableDerivAuthorization,
  looksLikeClassicApiToken,
  setManualToken,
  startDerivAuth,
  storeAuthInfo,
  authorizeWithToken,
  type AuthInfo,
} from "@/lib/deriv-auth";
import { resolveTradingToken } from "@/lib/deriv-trading";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("Deriv token detection", () => {
  it("treats short opaque API tokens as classic", () => {
    expect(looksLikeClassicApiToken("a1B2c3D4e5F6g7H8")).toBe(true);
    expect(looksLikeClassicApiToken("AbCdEfGhIjKlMnOp")).toBe(true);
  });

  it("treats JWT-shaped Auth 2.0 tokens as non-classic", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(looksLikeClassicApiToken(jwt)).toBe(false);
  });

  it("rejects empty tokens", () => {
    expect(looksLikeClassicApiToken("")).toBe(false);
    expect(looksLikeClassicApiToken("   ")).toBe(false);
  });

  it("keeps legacy classic API tokens usable after the old 24-hour expiry", async () => {
    const token = "classic-api-token-123456";
    const expiredAuthInfo: AuthInfo = {
      access_token: token,
      token_type: "Bearer",
      expires_in: 86400,
      expires_at: Math.floor(Date.now() / 1000) - 1,
      scope: "trade account_manage",
    };
    storeAuthInfo(expiredAuthInfo);
    setManualToken(token);

    expect(hasUsableDerivAuthorization()).toBe(true);
    await expect(resolveTradingToken()).resolves.toBe(token);
  });

  it("rejects an expired OAuth token when no refresh token is available", async () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXJpdiIsImlhdCI6MTUxNjIzOTAyMn0.signature";
    storeAuthInfo({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 1,
      scope: "trade account_manage",
    });
    setManualToken(token);

    expect(hasUsableDerivAuthorization()).toBe(false);
    await expect(resolveTradingToken()).resolves.toBeNull();
  });

  it("does not extend OAuth expiry when account authorization is rechecked", async () => {
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXJpdiIsImlhdCI6MTUxNjIzOTAyMn0.signature";
    const originalExpiry = Math.floor(Date.now() / 1000) + 900;
    storeAuthInfo({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: originalExpiry,
      scope: "trade account_manage",
      refresh_token: "refresh-token",
    });
    setManualToken(token);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ account_id: "VRTC123456", account_type: "demo", balance: 100, currency: "USD" }],
          }),
          { status: 200 },
        ),
      ),
    );

    try {
      const result = await authorizeWithToken(token);
      expect(result.success).toBe(true);
      expect(getStoredAuthInfo()?.expires_at).toBe(originalExpiry);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts OAuth without a prompt parameter", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });

    await startDerivAuth({
      clientId: "test-client",
      redirectUri: "https://example.com/callback",
    });

    const url = new URL(assign.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("prompt")).toBe(false);
    vi.unstubAllGlobals();
  });
});
