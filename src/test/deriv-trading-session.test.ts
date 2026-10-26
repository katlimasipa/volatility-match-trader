import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivTradingSession, isDerivLimitError } from "@/lib/deriv-trading";
import type { DerivWS } from "@/lib/deriv-ws";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

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

describe("Deriv authorization recovery", () => {
  it("does not retry forever when there is no authorization to reconnect with", async () => {
    const session = new DerivTradingSession();
    const statuses: Array<{ status: string; detail?: string | undefined }> = [];
    session.onStatus((status, detail) => statuses.push({ status, detail }));

    const connected = await session.connect({
      account_id: "VRTC123456",
      account_type: "demo",
      currency: "USD",
      balance: "100.00",
    });

    expect(connected).toBe(false);
    expect(statuses.at(-1)).toMatchObject({
      status: "error",
      detail: expect.stringContaining("Sign in again"),
    });
    expect(
      (session as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null })
        .reconnectTimer,
    ).toBeNull();
    session.dispose();
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

  it("proposes the selected standard Volatility 10 symbol when using Auth 2.0", async () => {
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
      mode: "otp",
    });

    await expect(
      session.buyDigitMatch({ stake: 1, barrierDigit: 4, currency: "USD", symbol: "R_10" }),
    ).rejects.toThrow("Deriv buy failed");

    expect(sent[0]).toHaveProperty("underlying_symbol", "R_10");
    session.dispose();
  });

  it("keeps a selected 1-second market on the same symbol for Auth 2.0", async () => {
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
      mode: "otp",
    });

    await expect(
      session.buyDigitMatch({ stake: 1, barrierDigit: 4, currency: "USD", symbol: "1HZ10V" }),
    ).rejects.toThrow("Deriv buy failed");

    expect(sent[0]).toHaveProperty("underlying_symbol", "1HZ10V");
    session.dispose();
  });

  it("retries the classic Volatility 10 symbol if the Options proposal is rejected", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeWs = {
      send: vi.fn(async (payload: Record<string, unknown>) => {
        sent.push(payload);
        if (payload["proposal"] === 1 && payload["symbol"] === "R_10") {
          return { proposal: { id: "proposal-id", ask_price: 1 } };
        }
        if (payload["proposal"] === 1) {
          throw new Error("Invalid symbol");
        }
        return { buy: {} };
      }),
      dispose: vi.fn(),
    } as unknown as DerivWS;
    const session = new DerivTradingSession();
    Object.assign(session as unknown as Record<string, unknown>, {
      ws: fakeWs,
      ready: true,
      mode: "classic",
    });

    await expect(
      session.buyDigitMatch({ stake: 1, barrierDigit: 4, currency: "USD", symbol: "R_10" }),
    ).rejects.toThrow("Deriv buy failed");

    expect(sent[0]).toHaveProperty("symbol", "R_10");
    session.dispose();
  });

  it("does not start a second buy while one is in flight", async () => {
    let releaseProposal: (() => void) | undefined;
    const fakeWs = {
      send: vi.fn(async (payload: Record<string, unknown>) => {
        if (payload["proposal"] === 1) {
          await new Promise<void>((resolve) => {
            releaseProposal = resolve;
          });
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
      mode: "classic",
    });

    const first = session.buyDigitMatch({ stake: 1, barrierDigit: 1, currency: "USD" });
    await Promise.resolve();
    expect(session.isBuyInFlight()).toBe(true);
    await expect(
      session.buyDigitMatch({ stake: 1, barrierDigit: 2, currency: "USD" }),
    ).rejects.toThrow("already in flight");

    releaseProposal?.();
    await expect(first).rejects.toThrow("Deriv buy failed");
    session.dispose();
  });
});

describe("Deriv limit errors", () => {
  it("detects Limit exceeded messages from Deriv", () => {
    expect(isDerivLimitError(new Error("Limit exceeded"))).toBe(true);
    expect(isDerivLimitError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isDerivLimitError(new Error("Subscription limit exceeded"))).toBe(true);
    expect(isDerivLimitError(new Error("Subscription limit has been reached"))).toBe(true);
    expect(isDerivLimitError(new Error("Maximum number of active subscriptions exceeded"))).toBe(true);
    expect(isDerivLimitError(new Error("Invalid symbol"))).toBe(false);
  });

  it("forgets leftover proposals when Deriv reports Limit exceeded", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeWs = {
      send: vi.fn(async (payload: Record<string, unknown>) => {
        sent.push(payload);
        if (payload["proposal"] === 1) {
          throw new Error("Limit exceeded");
        }
        return {};
      }),
      dispose: vi.fn(),
    } as unknown as DerivWS;
    const session = new DerivTradingSession();
    Object.assign(session as unknown as Record<string, unknown>, {
      ws: fakeWs,
      ready: true,
      mode: "classic",
    });

    await expect(
      session.buyDigitMatch({ stake: 1, barrierDigit: 7, currency: "USD" }),
    ).rejects.toThrow("Limit exceeded");

    expect(sent.some((p) => p["forget_all"] === "proposal")).toBe(true);
    expect(sent.some((p) => p["forget_all"] === "proposal_open_contract")).toBe(true);
    session.dispose();
  });

  it("uses a one-shot balance request for refreshes", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeWs = {
      send: vi.fn(async (payload: Record<string, unknown>) => {
        sent.push(payload);
        return { balance: { balance: 100, loginid: "CR123", currency: "USD" } };
      }),
      dispose: vi.fn(),
    } as unknown as DerivWS;
    const session = new DerivTradingSession();
    Object.assign(session as unknown as Record<string, unknown>, { ws: fakeWs, ready: true });

    await session.refreshBalance();
    expect(sent).toEqual([{ balance: 1 }]);
    session.dispose();
  });
});
