import { describe, expect, it, vi } from "vitest";
import { DerivTradingSession } from "@/lib/deriv-trading";
import type { DerivWS } from "@/lib/deriv-ws";

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

describe("DIGITMATCH proposal payload", () => {
  it.each(["otp", "classic"] as const)(
    "uses the %s symbol field and buys the returned proposal",
    async (mode) => {
      const sent: Record<string, unknown>[] = [];
      const fakeWs = {
        send: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload);
          if (payload["proposal"] === 1) {
            return { proposal: { id: "proposal-id", ask_price: 1 } };
          }
          return { buy: {} };
        }),
        dispose: vi.fn(),
      } as unknown as DerivWS;
      const session = new DerivTradingSession();
      Object.assign(session as unknown as Record<string, unknown>, {
        ws: fakeWs,
        ready: true,
        mode,
      });

      await expect(
        session.buyDigitMatch({ stake: 1, barrierDigit: 7, currency: "USD" }),
      ).rejects.toThrow("Deriv buy failed");

      const proposal = sent[0];
      expect(proposal).toMatchObject({
        proposal: 1,
        amount: 1,
        basis: "stake",
        contract_type: "DIGITMATCH",
        currency: "USD",
        duration: 1,
        duration_unit: "t",
        barrier: "7",
      });
      if (mode === "otp") {
        expect(proposal).toHaveProperty("underlying_symbol", "R_100");
        expect(proposal).not.toHaveProperty("symbol");
      } else {
        expect(proposal).toHaveProperty("symbol", "R_100");
        expect(proposal).not.toHaveProperty("underlying_symbol");
      }
      expect(sent[1]).toEqual({ buy: "proposal-id", price: 1 });

      session.dispose();
    },
  );
});

describe("DIGITMATCH quote", () => {
  it.each(["otp", "classic"] as const)(
    "uses the %s symbol field and returns the proposal values without buying",
    async (mode) => {
      const sent: Record<string, unknown>[] = [];
      const fakeWs = {
        send: vi.fn(async (payload: Record<string, unknown>) => {
          sent.push(payload);
          return { proposal: { ask_price: "2.50", payout: "16.68" } };
        }),
        dispose: vi.fn(),
      } as unknown as DerivWS;
      const session = new DerivTradingSession();
      Object.assign(session as unknown as Record<string, unknown>, {
        ws: fakeWs,
        ready: true,
        mode,
      });

      await expect(
        session.quoteDigitMatch({ stake: 2.5, barrierDigit: 4, currency: "USD" }),
      ).resolves.toEqual({ askPrice: 2.5, payout: 16.68 });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        proposal: 1,
        amount: 2.5,
        basis: "stake",
        contract_type: "DIGITMATCH",
        currency: "USD",
        duration: 1,
        duration_unit: "t",
        barrier: "4",
      });
      if (mode === "otp") {
        expect(sent[0]).toHaveProperty("underlying_symbol", "R_100");
        expect(sent[0]).not.toHaveProperty("symbol");
      } else {
        expect(sent[0]).toHaveProperty("symbol", "R_100");
        expect(sent[0]).not.toHaveProperty("underlying_symbol");
      }

      session.dispose();
    },
  );

  it("rejects a quote with no payout", async () => {
    const fakeWs = {
      send: vi.fn(async () => ({ proposal: { ask_price: "1.00" } })),
      dispose: vi.fn(),
    } as unknown as DerivWS;
    const session = new DerivTradingSession();
    Object.assign(session as unknown as Record<string, unknown>, {
      ws: fakeWs,
      ready: true,
      mode: "otp",
    });

    await expect(
      session.quoteDigitMatch({ stake: 1, barrierDigit: 5 }),
    ).rejects.toThrow("Deriv did not return a payout");

    session.dispose();
  });
});
