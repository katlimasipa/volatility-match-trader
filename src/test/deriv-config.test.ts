import { describe, expect, it } from "vitest";
import { PRODUCTION_REDIRECT_URI, getAppIdMarkup } from "@/lib/deriv-config";

describe("Deriv config", () => {
  it("keeps production redirect with trailing slash", () => {
    expect(PRODUCTION_REDIRECT_URI).toBe("https://thdpstmatches.vercel.app/");
    expect(PRODUCTION_REDIRECT_URI.endsWith("/")).toBe(true);
  });

  it("defaults app markup to a non-negative percent", () => {
    expect(getAppIdMarkup()).toBeGreaterThanOrEqual(0);
  });
});
