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
