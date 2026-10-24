/**
 * Live Deriv trading session: Auth 2.0 OTP WebSocket or classic authorize,
 * balance subscription, DIGITMATCH proposal + buy, and contract settlement.
 */

import { DerivWS, DERIV_CLASSIC_WS_URLS } from './deriv-ws';
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
import { getMarketConfig, marketTradeSymbols } from './matches';

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  payout: number;
  buyPrice: number;
  exitDigit?: number | undefined;
  status: string;
  balanceAfter?: number | undefined;
}

export interface BuyMatchParams {
  stake: number;
  barrierDigit: number;
  currency: string;
  symbol?: string;
}

type BalanceListener = (loginid: string, balance: number, currency: string) => void;
type ContractListener = (result: ContractResult) => void;
type StatusListener = (status: 'connecting' | 'ready' | 'offline' | 'error', detail?: string) => void;

/** Classic Binary WS accepts numeric app_ids or registered client IDs. */
const CLASSIC_WS_APP_IDS = [getDerivClientId(), '1089', HARDCODED_APP_ID].filter(
  (v, i, a) => Boolean(v) && a.indexOf(v) === i
);

function isFakeAccountId(id: string): boolean {
  return id === 'VRTC1029384' || id === 'CR91945350';
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

export function isDerivLimitError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    /limit.{0,40}(?:exceed|reach)|(?:exceed|reach).{0,40}limit/i.test(message) ||
    /subscriptions?.{0,40}(?:limit|maximum)|(?:limit|maximum).{0,40}subscriptions?/i.test(message) ||
    /rate limit|too many (?:requests|subscriptions)|max(imum)? (number of )?contracts/i.test(message)
  );
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
    if (info.expires_at <= now) {
      return manual && manual !== info.access_token ? manual : null;
    }
  }

  if (info?.expires_at && info.expires_at <= now) {
    return manual && manual !== info.access_token ? manual : null;
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

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 12000);
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
        signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
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
  private lastAccount: DerivAccount | null = null;
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
  private buyInFlight = false;
  private lastBalance: number | null = null;
  private balancePollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private reconnectAttempts = 0;

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
    return this.ready && !this.disposed && Boolean(this.ws?.isOpen());
  }

  isBuyInFlight(): boolean {
    return this.buyInFlight;
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
      // Push every account balance into the UI so demo/real both stay current
      for (const acc of rest.accounts) {
        const bal = Number(acc.balance);
        if (Number.isFinite(bal)) {
          this.emitBalance(acc.account_id, bal, acc.currency || this.currency);
        }
      }

      const match =
        rest.accounts.find((a) => a.account_id.toUpperCase() === this.accountId!.toUpperCase()) ||
        rest.accounts[0];
      if (!match) return null;

      const bal = Number(match.balance);
      if (!Number.isFinite(bal)) return null;
      return bal;
    } catch (err) {
      console.warn('[deriv-trading] REST balance sync failed:', err);
      return null;
    }
  }

  connect(account: DerivAccount, retryAttempt = 0): Promise<boolean> {
    if (this.connectPromise) return this.connectPromise;
    const attempt = this.connectInternal(account, retryAttempt);
    this.connectPromise = attempt;
    void attempt.finally(() => {
      if (this.connectPromise === attempt) this.connectPromise = null;
    }).catch(() => {});
    return attempt;
  }

  private async connectInternal(account: DerivAccount, retryAttempt: number): Promise<boolean> {
    if (this.disposed) return false;
    if (isFakeAccountId(account.account_id)) {
      this.emitStatus('error', 'Connect a real Deriv account before live trading.');
      return false;
    }

    // Keep any bought contract registered while its settlement subscription is
    // restored on the new socket. A brief network drop must not mark it failed.
    this.disconnectSocket(true);
    this.lastAccount = account;
    this.accountId = account.account_id;
    this.currency = account.currency || 'USD';
    this.ready = false;
    this.emitStatus('connecting');

    const token = await resolveTradingToken();
    if (!token) {
      this.emitStatus('error', 'No Deriv authorization. Please sign in with Deriv Auth 2.0.');
      this.scheduleAutoReconnect(retryAttempt);
      return false;
    }

    const connectOtp = async () => {
      const otpUrl = await fetchAuthenticatedWsUrl(account.account_id, token);
      return otpUrl ? this.openSocket(otpUrl, 'otp', false) : false;
    };

    const connectClassic = async () => {
      const classicUrls = new Set<string>();
      for (const appId of CLASSIC_WS_APP_IDS.length ? CLASSIC_WS_APP_IDS : ['1089']) {
        classicUrls.add(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
        classicUrls.add(`wss://ws.binaryws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
      }
      for (const url of classicUrls) {
        if (await this.openSocket(url, 'classic', true, token)) return true;
      }
      return false;
    };

    const isClassicToken = looksLikeClassicApiToken(token);
    if (!isClassicToken && (await connectOtp())) return true;
    if (await connectClassic()) return true;
    if (isClassicToken && (await connectOtp())) return true;

    this.scheduleAutoReconnect(retryAttempt);
    this.emitStatus('error', 'Could not open an authorized Deriv trading connection.');
    return false;
  }

  /**
   * Retry a failed connect with exponential backoff so temporary network drops
   * self-heal instead of leaving the session dead until manual action.
   */
  private scheduleAutoReconnect(attempt: number) {
    if (this.disposed || !this.lastAccount) return;
    if (this.reconnectTimer) return;
    const nextAttempt = attempt + 1;
    this.reconnectAttempts = nextAttempt;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(nextAttempt - 1, 5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && this.lastAccount) {
        void this.connect(this.lastAccount, nextAttempt);
      }
    }, delay);
  }

  private async openSocket(
    url: string,
    mode: 'otp' | 'classic',
    authorizeFirst: boolean,
    token?: string
  ): Promise<boolean> {
    let ws: DerivWS | null = null;
    try {
      ws = new DerivWS(url, undefined, {
        autoReconnect: false,
        onClose: () => {
          if (this.disposed || this.ws !== ws) return;
          this.ready = false;
          this.emitStatus('offline', 'Trading connection lost — reconnecting...');
          this.scheduleAutoReconnect(this.reconnectAttempts);
        },
      });
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
      if (this.stableConnectionTimer) clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = setTimeout(() => {
        this.stableConnectionTimer = null;
        if (this.isReady()) this.reconnectAttempts = 0;
      }, 30000);

      // Restore contract monitoring before a recovered session can accept
      // another purchase. Deriv returns the current state even if it settled
      // while this client was reconnecting.
      for (const contractId of this.openContracts.keys()) {
        this.subscribeOpenContract(ws, contractId);
      }

      // Confirm opening balance against REST (Auth 2.0 source of truth)
      this.syncBalanceFromRest().catch(() => {});
      return true;
    } catch (err) {
      console.warn('[deriv-trading] openSocket failed:', url, err);
      try {
        ws?.dispose();
      } catch {
        // The socket may already be closed; cleanup is best-effort.
      }
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

  private subscribeOpenContract(ws: DerivWS, contractId: number): void {
    void ws.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).catch((err) => {
      if (this.disposed || this.ws !== ws) return;
      console.warn('[deriv-trading] Could not restore contract monitoring:', contractId, err);
      this.ready = false;
      this.emitStatus('offline', 'Restoring open contract monitoring — reconnecting...');
      this.scheduleAutoReconnect(this.reconnectAttempts);
    });
  }

  private proposalPayload(
    amount: number,
    currency: string,
    barrier: string,
    underlying: string,
  ): Record<string, unknown> {
    return {
      proposal: 1,
      amount,
      basis: 'stake',
      contract_type: 'DIGITMATCH',
      currency,
      duration: 1,
      duration_unit: 't',
      barrier,
      ...(this.mode === 'otp'
        ? { underlying_symbol: underlying }
        : { symbol: underlying }),
    };
  }

  /**
   * Drop leftover proposal/open-contract subscriptions so Deriv stops counting them
   * against the shared buy/proposal limit.
   */
  async recoverFromContractLimit(): Promise<void> {
    if (!this.ws || !this.ready) return;
    try {
      await this.ws.send({ forget_all: 'proposal' });
    } catch {
      // Continue cleanup even if Deriv already removed these proposals.
    }
    try {
      await this.ws.send({ forget_all: 'proposal_open_contract' });
    } catch {
      // Continue cleanup even if Deriv already removed these contracts.
    }
    try {
      await this.ws.send({ portfolio: 1 });
    } catch {
      // The portfolio request is only a best-effort refresh after cleanup.
    }
  }

  /**
   * Place a 1-tick DIGITMATCH contract on the selected standard or 1-second market.
   */
  async buyDigitMatch(params: BuyMatchParams): Promise<ContractResult> {
    if (this.buyInFlight) {
      throw new Error('A trade is already in flight. Waiting for settlement.');
    }

    if (!this.ws || !this.ready) {
      if (this.lastAccount) {
        console.log('[deriv-trading] Trading session not ready on buyDigitMatch, fast-reconnecting...');
        await this.connect(this.lastAccount).catch(() => {});
      }
      if (!this.ws || !this.ready) {
        throw new Error('Trading session is not ready. Connect Deriv first.');
      }
    }

    this.buyInFlight = true;
    const barrier = String(Math.max(0, Math.min(9, Math.floor(params.barrierDigit))));
    const amount = Math.round(params.stake * 100) / 100;
    const currency = params.currency || this.currency || 'USD';
    const market = getMarketConfig(params.symbol);
    const { preferred, fallback } = marketTradeSymbols(market, this.mode);
    const symbols = preferred === fallback ? [preferred] : [preferred, fallback];

    try {
      let proposalRes: Record<string, unknown> | null = null;
      let lastErr: Error | null = null;

      for (const underlying of symbols) {
        try {
          const res = await this.ws.send(this.proposalPayload(amount, currency, barrier, underlying));
          const proposal = res['proposal'] as { id?: string } | undefined;
          if (proposal?.id) {
            proposalRes = res;
            break;
          }
          lastErr = new Error(
            (res?.['error'] as { message?: string })?.message ||
              'Deriv did not return a proposal id for DIGITMATCH.',
          );
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(errorMessage(err));
          if (isDerivLimitError(err)) {
            await this.recoverFromContractLimit();
            throw lastErr;
          }
          if (underlying === preferred && symbols.length > 1) {
            continue;
          }
          throw lastErr;
        }
      }

      const proposal = proposalRes?.['proposal'] as {
        id?: string;
        ask_price?: number | string;
        payout?: number | string;
      };
      if (!proposal?.id) {
        throw lastErr || new Error('Deriv did not return a proposal id for DIGITMATCH.');
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

      const buy = buyRes?.buy;
      if (!buy?.contract_id) {
        const errMsg =
          (buyRes as Record<string, unknown>)?.['error']
            ? ((buyRes as Record<string, unknown>)['error'] as { message?: string })?.message
            : 'Deriv buy failed — no contract id returned.';
        const fail = new Error(errMsg || 'Deriv buy failed — no contract id returned.');
        if (isDerivLimitError(fail)) {
          await this.recoverFromContractLimit();
        }
        throw fail;
      }

      const loginid = this.accountId;
      const buyPrice = Number(buy.buy_price ?? ask);
      if (buy.balance_after !== undefined && buy.balance_after !== null && loginid) {
        this.emitBalance(loginid, Number(buy.balance_after), currency);
      } else if (loginid && this.lastBalance !== null) {
        this.emitBalance(loginid, roundMoney(this.lastBalance - buyPrice), currency);
      }

      const contractId = buy.contract_id;
      // Register settlement before sending its subscription. If the socket
      // drops after Deriv accepted the buy, reconnect can restore this contract
      // instead of reporting a false purchase failure or buying twice.
      void this.refreshBalance();

      return await new Promise<ContractResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.openContracts.delete(contractId);
          this.ws?.send({ forget_all: 'proposal_open_contract' }).catch(() => {});
          reject(new Error('Timed out waiting for contract settlement after reconnect attempts.'));
        }, 120000);

        this.openContracts.set(contractId, {
          stake: amount,
          barrier: Number(barrier),
          resolve: (result) => {
            clearTimeout(timer);
            this.ws?.send({ forget_all: 'proposal_open_contract' }).catch(() => {});
            resolve(result);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        const ws = this.ws;
        if (ws && this.isReady()) this.subscribeOpenContract(ws, contractId);
        else this.scheduleAutoReconnect(this.reconnectAttempts);
      });
    } catch (err) {
      if (isDerivLimitError(err)) {
        await this.recoverFromContractLimit();
      }
      throw err;
    } finally {
      this.buyInFlight = false;
    }
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
      }>({ balance: 1 });
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

  private disconnectSocket(preserveOpenContracts = false) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
    this.stopBalancePoll();
    if (this.ws) {
      this.ws.dispose();
      this.ws = null;
    }
    this.ready = false;
    this.mode = null;
    if (!preserveOpenContracts) {
      for (const [, pending] of this.openContracts) {
        pending.reject(new Error('Trading session disconnected.'));
      }
      this.openContracts.clear();
    }
  }

  dispose() {
    this.disposed = true;
    this.disconnectSocket();
    this.balanceListeners.clear();
    this.contractListeners.clear();
    this.statusListeners.clear();
  }
}
