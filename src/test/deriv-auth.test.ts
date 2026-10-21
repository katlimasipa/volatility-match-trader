import { describe, expect, it } from "vitest";
import { looksLikeClassicApiToken } from "@/lib/deriv-auth";

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
});
