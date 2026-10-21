import { describe, expect, it, vi } from "vitest";
import { looksLikeClassicApiToken, startDerivAuth } from "@/lib/deriv-auth";

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
