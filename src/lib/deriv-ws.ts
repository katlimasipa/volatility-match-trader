/**
 * Deriv WebSocket Manager
 * Handles tick streams, balance subscriptions, proposals, and contract execution.
 */

import { getDerivClientId, getDerivWsUrl } from './deriv-config';

type MessageHandler = (data: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export const DERIV_PUBLIC_WS_URL = getDerivWsUrl();
export const DERIV_FALLBACK_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(getDerivClientId() || '1089')}`;

export class DerivWS {
  private ws: WebSocket | null = null;
  private reqIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private subscriptionHandlers = new Map<string, MessageHandler>();
  private activeSubscriptions = new Map<string, Record<string, unknown>>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange: ((status: 'connecting' | 'live' | 'offline') => void) | null = null;
  private url: string;
  private isDisposed = false;
  private isConnecting = false;
  private openWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(url?: string, onStatusChange?: (status: 'connecting' | 'live' | 'offline') => void) {
    this.url = url || getDerivWsUrl();
    this.onStatusChange = onStatusChange || null;
    this.connect();
  }

  public updateUrl(url: string): void {
    this.url = url;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.reconnect();
    }
  }

  public connect(): void {
    if (this.isDisposed || this.isConnecting) return;
    this.isConnecting = true;
    this.onStatusChange?.('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.onStatusChange?.('live');
        this.startPing();

        // Resolve any callers awaiting connection
        const waiters = [...this.openWaiters];
        this.openWaiters = [];
        waiters.forEach((w) => w.resolve());

        // Resubscribe to any active subscriptions after reconnect
        for (const [key, payload] of this.activeSubscriptions.entries()) {
          this.send(payload).catch((err) => {
            console.warn(`Resubscription failed for ${key}:`, err);
          });
        }
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.stopPing();
        this.onStatusChange?.('offline');

        const waiters = [...this.openWaiters];
        this.openWaiters = [];
        waiters.forEach((w) => w.reject(new Error('WebSocket closed before opening')));

        if (!this.isDisposed) {
          if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = setTimeout(() => {
            const primary = getDerivWsUrl();
            const fallback = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(getDerivClientId() || '1089')}`;
            if (this.url.startsWith('wss://api.derivws.com')) {
              this.url = fallback;
            } else {
              this.url = primary;
            }
            this.connect();
          }, 2500);
        }
      };

      this.ws.onerror = (e) => {
        console.warn('Deriv WebSocket error event:', e);
        this.onStatusChange?.('offline');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const reqId = typeof data['req_id'] === 'number' ? data['req_id'] : null;

          // Settle pending one-off request
          if (reqId !== null && this.pendingRequests.has(reqId)) {
            const p = this.pendingRequests.get(reqId)!;
            this.pendingRequests.delete(reqId);
            if (data['error']) {
              const err = data['error'] as { message?: string };
              p.reject(new Error(err.message || 'Deriv API error'));
            } else {
              p.resolve(data);
            }
          }

          // Trigger subscription listeners by subscription.id
          if (data['subscription']) {
            const sub = data['subscription'] as { id?: string };
            if (sub.id && this.subscriptionHandlers.has(sub.id)) {
              this.subscriptionHandlers.get(sub.id)!(data);
            }
          }

          // Message type based routing (e.g. tick, history, proposal_open_contract)
          const msgType = data['msg_type'] as string;
          if (msgType && this.subscriptionHandlers.has(msgType)) {
            this.subscriptionHandlers.get(msgType)!(data);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };
    } catch {
      this.isConnecting = false;
      this.onStatusChange?.('offline');
      if (!this.isDisposed) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
      }
    }
  }

  public reconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.connect();
  }

  public async waitForOpen(timeoutMs = 10000): Promise<void> {
    if (this.isDisposed) throw new Error('WebSocket is disposed');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openWaiters = this.openWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.openWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect();
      }
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public async send<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
    if (this.isDisposed) {
      throw new Error('WebSocket is disposed');
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.waitForOpen();
    }

    const reqId = ++this.reqIdCounter;
    const msg = { ...payload, req_id: reqId };

    // If it's a persistent subscription request, track it for auto-resubscription on reconnect
    if (payload['subscribe'] === 1 || payload['ticks_history']) {
      const key = String(
        payload['ticks_history'] ||
          payload['ticks'] ||
          (payload['balance'] ? 'balance' : null) ||
          (payload['proposal_open_contract'] ? `poc:${payload['contract_id']}` : null) ||
          `sub:${reqId}`
      );
      this.activeSubscriptions.set(key, payload);
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(reqId, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
      });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  public registerHandler(key: string, handler: MessageHandler): () => void {
    this.subscriptionHandlers.set(key, handler);
    return () => {
      this.subscriptionHandlers.delete(key);
    };
  }

  public dispose(): void {
    this.isDisposed = true;
    this.isConnecting = false;
    this.stopPing();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.pendingRequests.clear();
    this.subscriptionHandlers.clear();
    this.activeSubscriptions.clear();
    this.openWaiters = [];
  }
}
