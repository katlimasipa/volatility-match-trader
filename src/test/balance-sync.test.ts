import { describe, expect, it } from "vitest";
import { looksLikeClassicApiToken } from "@/lib/deriv-auth";

/**
 * After buy, lastBalance is stake-deducted.
 * Final = lastBalance + buyPrice + profit
 */
function settleBalance(lastBalance: number, buyPrice: number, profit: number): number {
  return Math.round((lastBalance + buyPrice + profit) * 100) / 100;
}

function findAccountCaseInsensitive(
  accounts: { account_id: string; balance: string }[],
  activeId: string
) {
  return (
    accounts.find((a) => a.account_id.toUpperCase() === activeId.toUpperCase()) || accounts[0]
  );
}

describe("Balance sync rules", () => {
  it("updates balance on buy debit then settle win", () => {
    let bal = 1000;
    const stake = 10;
    bal = bal - stake;
    expect(bal).toBe(990);
    // profit 79.29 → final = afterBuy + stake + profit = beforeBuy + profit
    bal = settleBalance(bal, stake, 79.29);
    expect(bal).toBeCloseTo(1079.29, 2);
  });

  it("keeps balance after loss when stake already deducted", () => {
    let bal = 1000;
    const stake = 10;
    bal = bal - stake;
    bal = settleBalance(bal, stake, -stake);
    expect(bal).toBe(990);
  });

  it("resolves active account ignoring loginid casing", () => {
    const accounts = [
      { account_id: "VRTC123", balance: "50.00" },
      { account_id: "CR999", balance: "200.00" },
    ];
    expect(findAccountCaseInsensitive(accounts, "vrtc123")?.balance).toBe("50.00");
    expect(findAccountCaseInsensitive(accounts, "cr999")?.balance).toBe("200.00");
  });

  it("never treats JWT Auth 2.0 tokens as classic API tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(looksLikeClassicApiToken(jwt)).toBe(false);
  });
});
