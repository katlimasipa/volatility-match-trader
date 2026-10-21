import { getAppIdMarkup } from "./deriv-config";

/**
 * Deriv Digit Matches contract payout pricing:
 * Deriv charges an 11.20% probability rate for Digit Match (1 out of 10 digits).
 * Base Gross Payout = Stake / 0.1120 = Stake * 8.9285714...
 *
 * Developer App Markup (registered on the Deriv Developer Portal):
 * Markup Fee = Gross Payout * Markup%
 * Effective Client Payout = Gross Payout * (1 - Markup%)
 * Net Win Profit (P/L) = Effective Client Payout - Stake
 */
export const DERIV_MATCH_BASE_PAYOUT_RATIO = 100 / 11.2; // 8.92857142857

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scalePayoutFromRatio(
  stake: number,
  ratio: number
): { payout: number; profit: number } {
  const payout = roundMoney(stake * ratio);
  return { payout, profit: roundMoney(payout - stake) };
}

export function ratioFromContract(buyPrice: number, payout: number): number | null {
  if (
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(payout) ||
    buyPrice <= 0 ||
    payout <= 0
  ) {
    return null;
  }
  return payout / buyPrice;
}

function matchRatioStorageKey(accountId: string | null | undefined): string | null {
  const normalizedAccountId = accountId?.trim().toUpperCase();
  return normalizedAccountId ? `thdpst_match_ratio_${normalizedAccountId}` : null;
}

export function getStoredMatchRatio(accountId: string | null | undefined): number | null {
  const key = matchRatioStorageKey(accountId);
  if (!key || typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return null;
    const ratio = Number(stored);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  } catch {
    return null;
  }
}

export function setStoredMatchRatio(
  accountId: string | null | undefined,
  ratio: number
): void {
  const key = matchRatioStorageKey(accountId);
  if (!key || typeof window === "undefined" || !Number.isFinite(ratio) || ratio <= 0) return;
  try {
    window.localStorage.setItem(key, String(ratio));
  } catch {
    // Ignore storage failures; a live quote is still available in memory.
  }
}

export function calculateMatchesPayout(
  stake: number,
  markupPercent: number = getAppIdMarkup()
) {
  const baseGrossPayout = stake * DERIV_MATCH_BASE_PAYOUT_RATIO;
  const markupRate = markupPercent / 100;
  const clientGrossPayout = Math.round(baseGrossPayout * (1 - markupRate) * 100) / 100;
  const netWinProfit = Math.round((clientGrossPayout - stake) * 100) / 100;
  const markupFee = Math.round(baseGrossPayout * markupRate * 100) / 100;
  return {
    baseGrossPayout,
    clientGrossPayout,
    netWinProfit,
    markupFee,
    markupPercent,
    payoutMultiplier: stake > 0 ? clientGrossPayout / stake : 0,
  };
}
