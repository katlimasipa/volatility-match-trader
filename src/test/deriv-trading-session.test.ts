import { describe, expect, it } from "vitest";

/**
 * Settlement balance math:
 * After buy, lastBalance is already stake-deducted.
 * Final = lastBalance + buyPrice + profit
 * (loss: profit ≈ -buyPrice → unchanged; win: credits payout)
 */
function settleBalance(lastBalance: number, buyPrice: number, profit: number): number {
  return Math.round((lastBalance + buyPrice + profit) * 100) / 100;
}

describe("Live trade balance settlement", () => {
  it("keeps balance flat after a full loss (stake already deducted on buy)", () => {
    const beforeBuy = 1000;
    const buyPrice = 10;
    const afterBuy = beforeBuy - buyPrice;
    const profit = -buyPrice;
    expect(settleBalance(afterBuy, buyPrice, profit)).toBe(990);
  });

  it("credits payout after a win", () => {
    const beforeBuy = 1000;
    const buyPrice = 10;
    const afterBuy = beforeBuy - buyPrice;
    const payout = 85.5;
    const profit = payout - buyPrice;
    expect(settleBalance(afterBuy, buyPrice, profit)).toBeCloseTo(beforeBuy + profit, 2);
    expect(settleBalance(afterBuy, buyPrice, profit)).toBeCloseTo(afterBuy + payout, 2);
  });

  it("moves balance on every trade cycle", () => {
    let bal = 500;
    // buy 5
    bal = bal - 5;
    expect(bal).toBe(495);
    // lose
    bal = settleBalance(bal, 5, -5);
    expect(bal).toBe(495);
    // buy 5
    bal = bal - 5;
    // win +40 profit on 5 stake → payout 45
    bal = settleBalance(bal, 5, 40);
    expect(bal).toBe(535);
  });
});
