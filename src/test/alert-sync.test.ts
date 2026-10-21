import { describe, expect, it, beforeEach } from "vitest";
import { getDeviceId, resolveAlertRoomId } from "@/lib/alert-sync";

describe("Cross-device alert rooms", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("creates a stable device id", () => {
    const a = getDeviceId();
    const b = getDeviceId();
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("uses Deriv account id as the shared room", () => {
    expect(resolveAlertRoomId("VRTC12345")).toBe("deriv-VRTC12345");
    expect(resolveAlertRoomId("vrtc12345")).toBe("deriv-VRTC12345");
  });

  it("falls back to email session when no account", () => {
    localStorage.setItem("v100_user_email", "trader@example.com");
    expect(resolveAlertRoomId(null)).toBe("user-trader_example.com");
  });

  it("ignores the generic deriv_trader session label", () => {
    localStorage.setItem("v100_user_email", "deriv_trader");
    expect(resolveAlertRoomId(null)).toBeNull();
  });
});
