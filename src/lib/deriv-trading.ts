/**
 * Live Deriv trading session: Auth 2.0 OTP WebSocket or classic authorize,
 * balance subscription, DIGITMATCH proposal + buy, and contract settlement.
 */

import { DerivWS, DERIV_FALLBACK_WS_URL } from './deriv-ws';
import {
  fetchOptionsAccountsViaRest,
  getManualToken,
  getStoredAuthInfo,
  HARDCODED_APP_ID,
  looksLikeClassicApiToken,
  refreshAccessToken,
  storeAccounts,
  type DerivAccount,
} from './deriv-auth';
import { getDerivClientId } from './deriv-config';
import { CLASSIC_SYMBOL, OPTIONS_SYMBOL } from './matches';

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  payout: number;
  buyPrice: number;
  exitDigit?: number;
  status: string;
  balanceAfter?: number;
}

export interface BuyMatchParams {
  stake: number;
  barrierDigit: number;
  currency: string;
}

type BalanceListener = (loginid: string, balance: number, currency: string) => void;
type ContractListener = (result: ContractResult) => void;
type StatusListener = (status: 'connecting' | 'ready' | 'offline' | 'error', detail?: string) => void;

/** Classic Binary WS expects a numeric app_id; Auth 2.0 client ids are strings. */
const CLASSIC_WS_APP_IDS = ['1089', getDerivClientId(), HARDCODED_APP_ID].filter(
  (v, i, a) => Boolean(v) && /^\d+$/.test(v) && a.indexOf(v) === i
);

function isFakeAccountId(id: string): boolean {
  return id === 'VRTC1029384' || id === 'CR91945350';
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve a usable access token, refreshing Auth 2.0 when close to expiry.
 */
export async function resolveTradingToken(): Promise<string | null> {
  const info = getStoredAuthInfo();
  const manual = getManualToken();
  const now = Math.floor(Date.now() / 1000);

  if (info?.refresh_token && info.expires_at && info.expires_at <= now + 90) {
    const refreshed = await refreshAccessToken(getDerivClientId());
    if (refreshed?.access_token) return refreshed.access_token;
  }

  return info?.access_token || manual || null;
}

/**
 * Fetch an authenticated Options WebSocket URL (Deriv Auth 2.0 OTP).
 */
export async function fetchAuthenticatedWsUrl(
  accountId: string,
  token: string,
  appId: string = getDerivClientId()
): Promise<string | null> {
  const cleanId = accountId.trim();
  if (!cleanId || isFakeAccountId(cleanId)) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Deriv-App-ID': appId || HARDCODED_APP_ID,
    };

    const response = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(cleanId)}/otp`,
      {
        method: 'POST',
        headers,
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn('[deriv-trading] OTP failed:', response.status, text);
      return null;
    }

    const data = (await response.json()) as { data?: { url?: string }; url?: string };
    return data.data?.url || data.url || null;
  } catch (err) {
    console.warn('[deriv-trading] OTP request error:', err);
    return null;
  }
}

/**
 * Authorized trading connection used for balance + contract execution.
 * Market ticks stay on the public feed; this socket is for money movement.
 */
export class DerivTradingSession {
  private ws: DerivWS | null = null;
  private mode: 'otp' | 'classic' | null = null;
  private accountId: string | null = null;
  private currency = 'USD';
  private disposed = false;
  private balanceListeners = new Set<BalanceListener>();
  private contractListeners = new Set<ContractListener>();
  private statusListeners = new Set<StatusListener>();
  private openContracts = new Map<
    number,
    { stake: number; barrier: number; resolve: (r: ContractResult) => void; reject: (e: Error) => void }
  >();
  private ready = false;
  private lastBalance: number | null = null;
  private balancePollTimer: ReturnType<typeof setInterval> | null = null;

  onBalance(listener: BalanceListener): () => void {
    this.balanceListeners.add(listener);
    return () => this.balanceListeners.delete(listener);
  }

  onContract(listener: ContractListener): () => void {
    this.contractListeners.add(listener);
    return () => this.contractListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  isReady(): boolean {
    return this.ready && !this.disposed;
  }

  getMode(): 'otp' | 'classic' | null {
    return this.mode;
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  getLastBalance(): number | null {
    return this.lastBalance;
  }

  private emitStatus(status: 'connecting' | 'ready' | 'offline' | 'error', detail?: string) {
    this.statusListeners.forEach((fn) => fn(status, detail));
  }

  private emitBalance(loginid: string, balance: number, currency: string) {
    if (!Number.isFinite(balance)) return;
    this.lastBalance = balance;
    this.currency = currency || this.currency;
    this.balanceListeners.forEach((fn) => fn(loginid, balance, currency));
  }

  private emitContract(result: ContractResult) {
    this.contractListeners.forEach((fn) => fn(result));
  }

  private startBalancePoll() {
    this.stopBalancePoll();
    this.balancePollTimer = setInterval(() => {
      if (!this.ready || this.disposed) return;
      // Socket first; REST only if the socket has no balance yet
      this.refreshBalance()
        .then(() => {
          if (this.lastBalance === null) return this.syncBalanceFromRest();
          return null;
        })
        .catch(() => {});
    }, 15000);
  }

  private stopBalancePoll() {
    if (this.balancePollTimer) {
      clearInterval(this.balancePollTimer);
      this.balancePollTimer = null;
    }
  }

  /**
   * Pull live balance from the trading socket and/or Auth 2.0 REST accounts.
   * REST is the source of truth when the socket omits balance_after.
   */
  async syncBalance(preferRest = false): Promise<number | null> {
    if (this.disposed) return this.lastBalance;

    if (!preferRest) {
      await this.refreshBalance();
      if (this.lastBalance !== null) {
        // Still confirm against REST so the UI matches Deriv after buys
        const restBal = await this.syncBalanceFromRest();
        return restBal ?? this.lastBalance;
      }
    }

    const fromRest = await this.syncBalanceFromRest();
    if (fromRest !== null) return fromRest;
    await this.refreshBalance();
    return this.lastBalance;
  }

  private async syncBalanceFromRest(): Promise<number | null> {
    const token = await resolveTradingToken();
    if (!token || !this.accountId) return null;

    try {
      const rest = await fetchOptionsAccountsViaRest(token, getDerivClientId());
      if (!rest.success || rest.accounts.length === 0) return null;

      storeAccounts(rest.accounts);
      const match =
        rest.accounts.find((a) => a.account_id.toUpperCase() === this.accountId!.toUpperCase()) ||
        rest.accounts[0];
      if (!match) return null;

      const bal = Number(match.balance);
      if (!Number.isFinite(bal)) return null;
      this.emitBalance(match.account_id, bal, match.currency || this.currency);
      return bal;
    } catch (err) {
      console.warn('[deriv-trading] REST balance sync failed:', err);
      return null;
    }
  }

  async connect(account: DerivAccount): Promise<boolean> {
    if (this.disposed) return false;
    if (isFakeAccountId(account.account_id)) {
      this.emitStatus('error', 'Connect a real Deriv account before live trading.');
      return false;
    }

    this.disconnectSocket();
    this.accountId = account.account_id;
    this.currency = account.currency || 'USD';
    this.ready = false;
    this.emitStatus('connecting');

    const token = await resolveTradingToken();
    if (!token) {
      this.emitStatus('error', 'No Deriv token. Sign in with Auth 2.0 or paste an API token.');
      return false;
    }

    // Prefer Auth 2.0 OTP authenticated socket (required for OAuth / PAT)
    const otpUrl = await fetchAuthenticatedWsUrl(account.account_id, token);
    if (otpUrl) {
      const ok = await this.openSocket(otpUrl, 'otp', false);
      if (ok) return true;
    }

    // Classic Binary WebSocket + authorize (legacy API tokens)
    if (looksLikeClassicApiToken(token) || CLASSIC_WS_APP_IDS.length > 0) {
      for (const appId of CLASSIC_WS_APP_IDS.length ? CLASSIC_WS_APP_IDS : ['1089']) {
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`;
        const ok = await this.openSocket(url, 'classic', true, token);
        if (ok) return true;
      }

      const ok = await this.openSocket(DERIV_FALLBACK_WS_URL, 'classic', true, token);
      if (ok) return true;
    }

    this.emitStatus('error', 'Could not open an authorized Deriv trading connection.');
    return false;
  }

  private async openSocket(
    url: string,
    mode: 'otp' | 'classic',
    authorizeFirst: boolean,
    token?: string
  ): Promise<boolean> {
    let ws: DerivWS | null = null;
    try {
      ws = new DerivWS(url);
      await ws.waitForOpen(12000);

      if (authorizeFirst && token) {
        const authRes = await ws.send<{
          authorize?: {
            loginid?: string;
            balance?: number;
            currency?: string;
          };
        }>({ authorize: token });

        const auth = authRes.authorize;
        if (!auth?.loginid) {
          ws.dispose();
          return false;
        }

        this.accountId = String(auth.loginid);
        this.currency = String(auth.currency || this.currency);
        this.emitBalance(auth.loginid, Number(auth.balance || 0), this.currency);
      }

      this.attachHandlers(ws);
      const balRes = await ws.send<{
        balance?: { balance?: number | string; loginid?: string; currency?: string };
      }>({ balance: 1, subscribe: 1 });

      const bal = balRes.balance;
      if (bal && bal.balance !== undefined && bal.balance !== null) {
        const loginid = bal.loginid || this.accountId || '';
        if (loginid) {
          this.accountId = String(loginid);
          this.emitBalance(loginid, Number(bal.balance), bal.currency || this.currency);
        }
      }

      this.ws = ws;
      this.mode = mode;
      this.ready = true;
      this.emitStatus('ready', mode);
      this.startBalancePoll();

      // Confirm opening balance against REST (Auth 2.0 source of truth)
      this.syncBalanceFromRest().catch(() => {});
      return true;
    } catch (err) {
      console.warn('[deriv-trading] openSocket failed:', url, err);
      try {
        ws?.dispose();
      } catch {}
      return false;
    }
  }

  private attachHandlers(ws: DerivWS) {
    ws.registerHandler('balance', (data) => {
      const b = data['balance'] as {
        balance?: number | string;
        loginid?: string;
        currency?: string;
        accounts?: Record<string, { balance: number | string; currency: string }>;
      };
      if (!b) return;

      if (b.accounts) {
        for (const [loginid, row] of Object.entries(b.accounts)) {
          this.emitBalance(loginid, Number(row.balance), row.currency || this.currency);
        }
        return;
      }

      if (b.balance !== undefined && b.balance !== null) {
        const loginid = b.loginid || this.accountId || '';
        if (loginid) {
          this.currency = b.currency || this.currency;
          this.emitBalance(loginid, Number(b.balance), this.currency);
        }
      }
    });

    ws.registerHandler('proposal_open_contract', (data) => {
      const poc = data['proposal_open_contract'] as {
        contract_id?: number;
        is_sold?: number | boolean;
        status?: string;
        profit?: number | string;
        payout?: number | string;
        buy_price?: number | string;
        exit_tick_display_value?: string;
        tick_stream?: Array<{ tick_display_value?: string }>;
      };
      if (!poc?.contract_id) return;

      const pending = this.openContracts.get(poc.contract_id);
      const sold = Boolean(poc.is_sold) || poc.status === 'sold' || poc.status === 'won' || poc.status === 'lost';
      if (!sold || !pending) return;

      // Remove first so duplicate sold messages do not double-settle
      this.openContracts.delete(poc.contract_id);

      const profit = Number(poc.profit ?? 0);
      const buyPrice = Number(poc.buy_price ?? pending.stake);
      const payout = Number(poc.payout ?? (profit > 0 ? buyPrice + profit : 0));
      const won = profit > 0 || poc.status === 'won';

      let exitDigit: number | undefined;
      const exitDisplay = poc.exit_tick_display_value;
      if (exitDisplay) {
        const last = exitDisplay.replace(/[^0-9]/g, '').slice(-1);
        if (last) exitDigit = Number(last);
      } else if (poc.tick_stream?.length) {
        const lastTick = poc.tick_stream[poc.tick_stream.length - 1];
        const display = lastTick?.tick_display_value;
        if (display) {
          const last = display.replace(/[^0-9]/g, '').slice(-1);
          if (last) exitDigit = Number(last);
        }
      }

      // Stake already left the account on buy (lastBalance is post-buy).
      // After settle: final = lastBalance + buyPrice + profit
      // (loss: profit ≈ -buyPrice → no change; win: credits payout).
      const settleAdjust =
        this.lastBalance !== null ? roundMoney(this.lastBalance + buyPrice + profit) : null;

      void (async () => {
        if (settleAdjust !== null && this.accountId) {
          this.emitBalance(this.accountId, settleAdjust, this.currency);
        }

        const synced = await this.syncBalance(true);
        const result: ContractResult = {
          contractId: poc.contract_id!,
          won,
          profit,
          payout,
          buyPrice,
          exitDigit,
          status: poc.status || (won ? 'won' : 'lost'),
          balanceAfter: synced ?? this.lastBalance ?? settleAdjust ?? undefined,
        };

        pending.resolve(result);
        this.emitContract(result);
      })();
    });
  }

  /**
   * Place a 1-tick DIGITMATCH contract on Volatility 100.
   */
  async buyDigitMatch(params: BuyMatchParams): Promise<ContractResult> {
    if (!this.ws || !this.ready) {
      throw new Error('Trading session is not ready. Connect Deriv first.');
    }

    const barrier = String(Math.max(0, Math.min(9, Math.floor(params.barrierDigit))));
    const amount = Math.round(params.stake * 100) / 100;
    const currency = params.currency || this.currency || 'USD';
    const underlying = this.mode === 'otp' ? OPTIONS_SYMBOL : CLASSIC_SYMBOL;

    const proposalPayload: Record<string, unknown> = {
      proposal: 1,
      amount,
      basis: 'stake',
      contract_type: 'DIGITMATCH',
      currency,
      duration: 1,
      duration_unit: 't',
      barrier,
    };

    if (this.mode === 'otp') {
      proposalPayload['underlying_symbol'] = underlying;
    } else {
      proposalPayload['symbol'] = underlying;
    }

    let proposalRes: Record<string, unknown>;
    try {
      proposalRes = await this.ws.send(proposalPayload);
    } catch {
      const alt: Record<string, unknown> = {
        proposal: 1,
        amount,
        basis: 'stake',
        contract_type: 'DIGITMATCH',
        currency,
        duration: 1,
        duration_unit: 't',
        barrier,
      };
      if (this.mode === 'otp') {
        alt['underlying_symbol'] = CLASSIC_SYMBOL;
        alt['symbol'] = CLASSIC_SYMBOL;
      } else {
        alt['underlying_symbol'] = OPTIONS_SYMBOL;
        alt['symbol'] = OPTIONS_SYMBOL;
      }
      try {
        proposalRes = await this.ws.send(alt);
      } catch {
        proposalRes = await this.ws.send({
          proposal: 1,
          amount,
          basis: 'stake',
          contract_type: 'DIGITMATCH',
          currency,
          duration: 1,
          duration_unit: 't',
          barrier,
          symbol: CLASSIC_SYMBOL,
        });
      }
    }

    const proposal = proposalRes['proposal'] as {
      id?: string;
      ask_price?: number | string;
      payout?: number | string;
    };
    if (!proposal?.id) {
      throw new Error('Deriv did not return a proposal id for DIGITMATCH.');
    }

    const ask = Number(proposal.ask_price ?? amount);
    const buyRes = await this.ws.send<{
      buy?: {
        contract_id?: number;
        buy_price?: number | string;
        balance_after?: number | string;
      };
    }>({
      buy: proposal.id,
      price: ask,
    });

    const buy = buyRes.buy;
    if (!buy?.contract_id) {
      throw new Error('Deriv buy failed — no contract id returned.');
    }

    const loginid = this.accountId;
    const buyPrice = Number(buy.buy_price ?? ask);
    if (buy.balance_after !== undefined && buy.balance_after !== null && loginid) {
      this.emitBalance(loginid, Number(buy.balance_after), currency);
    } else if (loginid && this.lastBalance !== null) {
      this.emitBalance(loginid, roundMoney(this.lastBalance - buyPrice), currency);
    }

    // Confirm debit with Deriv (socket + REST)
    await this.syncBalance(false);

    const contractId = buy.contract_id;
    await this.ws.send({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1,
    });

    return new Promise<ContractResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openContracts.delete(contractId);
        reject(new Error('Timed out waiting for contract settlement.'));
      }, 45000);

      this.openContracts.set(contractId, {
        stake: amount,
        barrier: Number(barrier),
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async refreshBalance(): Promise<void> {
    if (!this.ws || !this.ready) return;
    try {
      const balRes = await this.ws.send<{
        balance?: {
          balance?: number | string;
          loginid?: string;
          currency?: string;
          accounts?: Record<string, { balance: number | string; currency: string }>;
        };
      }>({ balance: 1, subscribe: 1 });
      const bal = balRes.balance;
      if (!bal) return;

      if (bal.accounts) {
        for (const [loginid, row] of Object.entries(bal.accounts)) {
          this.emitBalance(loginid, Number(row.balance), row.currency || this.currency);
        }
        return;
      }

      if (bal.balance !== undefined && bal.balance !== null) {
        const loginid = bal.loginid || this.accountId || '';
        if (loginid) {
          this.emitBalance(loginid, Number(bal.balance), bal.currency || this.currency);
        }
      }
    } catch (err) {
      console.warn('[deriv-trading] refreshBalance failed:', err);
    }
  }

  private disconnectSocket() {
    this.stopBalancePoll();
    if (this.ws) {
      this.ws.dispose();
      this.ws = null;
    }
    this.ready = false;
    this.mode = null;
    for (const [, pending] of this.openContracts) {
      pending.reject(new Error('Trading session disconnected.'));
    }
    this.openContracts.clear();
  }

  dispose() {
    this.disposed = true;
    this.disconnectSocket();
    this.balanceListeners.clear();
    this.contractListeners.clear();
    this.statusListeners.clear();
  }
}
