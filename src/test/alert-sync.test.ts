import { describe, expect, it, beforeEach } from "vitest";
import { getDeviceId, resolveAlertRoomId, resolveAlertRoomIds } from "@/lib/alert-sync";
import { setActiveAccountId, storeAccounts } from "@/lib/deriv-auth";
import { shouldThrottle } from "@/lib/notifications";

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

  it("places the active account room first and includes stored accounts", () => {
    storeAccounts([
      { account_id: "VRTC12345", account_type: "demo", currency: "USD", balance: "0" },
      { account_id: "CR12345", account_type: "real", currency: "USD", balance: "0" },
    ]);
    setActiveAccountId("CR12345", "real");

    expect(resolveAlertRoomIds()).toEqual(["deriv-CR12345", "deriv-VRTC12345"]);
  });

  it("includes an explicit active room before stored account rooms", () => {
    storeAccounts([
      { account_id: "VRTC12345", account_type: "demo", currency: "USD", balance: "0" },
      { account_id: "CR12345", account_type: "real", currency: "USD", balance: "0" },
    ]);

    expect(resolveAlertRoomIds("CR99999")).toEqual([
      "deriv-CR99999",
      "deriv-VRTC12345",
      "deriv-CR12345",
    ]);
  });

  it("deduplicates account IDs without regard to case", () => {
    storeAccounts([
      { account_id: "VRTC12345", account_type: "demo", currency: "USD", balance: "0" },
      { account_id: "vrtc12345", account_type: "demo", currency: "USD", balance: "0" },
      { account_id: "CR12345", account_type: "real", currency: "USD", balance: "0" },
      { account_id: "cr12345", account_type: "real", currency: "USD", balance: "0" },
    ]);

    expect(resolveAlertRoomIds("vrtc12345")).toEqual(["deriv-VRTC12345", "deriv-CR12345"]);
  });

  it("caps the room list at ten", () => {
    storeAccounts(
      Array.from({ length: 12 }, (_, index) => ({
        account_id: `CR${index}`,
        account_type: "real" as const,
        currency: "USD",
        balance: "0",
      })),
    );

    const rooms = resolveAlertRoomIds("VRTC000");

    expect(rooms).toHaveLength(10);
    expect(rooms[0]).toBe("deriv-VRTC000");
    expect(rooms[9]).toBe("deriv-CR8");
  });

  it("lets the room override replace all account rooms", () => {
    storeAccounts([
      { account_id: "VRTC12345", account_type: "demo", currency: "USD", balance: "0" },
    ]);
    localStorage.setItem("thdpst_alert_room", "custom room");

    expect(resolveAlertRoomIds("CR12345")).toEqual(["custom_room"]);
  });

  it("falls back to email session when no account", () => {
    localStorage.setItem("v100_user_email", "trader@example.com");
    expect(resolveAlertRoomId(null)).toBe("user-trader_example.com");
    expect(resolveAlertRoomIds(null)).toEqual(["user-trader_example.com"]);
  });

  it("ignores the generic deriv_trader session label", () => {
    localStorage.setItem("v100_user_email", "deriv_trader");
    expect(resolveAlertRoomId(null)).toBeNull();
    expect(resolveAlertRoomIds(null)).toEqual([]);
  });
});

describe("notification throttling", () => {
  it("throttles events inside the window but allows the boundary", () => {
    expect(shouldThrottle(10_000, 69_999)).toBe(true);
    expect(shouldThrottle(10_000, 70_000)).toBe(false);
    expect(shouldThrottle(null, 10_000)).toBe(false);
  });
});
