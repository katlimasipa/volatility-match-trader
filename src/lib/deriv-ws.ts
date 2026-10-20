/**
 * Deriv WebSocket Manager
 * Handles tick streams, balance subscriptions, proposals, and contract execution.
 */

type MessageHandler = (data: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class DerivWS {
  private ws: WebSocket | null = null;
  private reqIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private subscriptionHandlers = new Map<string, MessageHandler>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange: ((status: 'connecting' | 'live' | 'offline') => void) | null = null;
  private url: string;
  private isDisposed = false;

  constructor(url: string, onStatusChange?: (status: 'connecting' | 'live' | 'offline') => void) {
    this.url = url;
    this.onStatusChange = onStatusChange || null;
    this.connect();
  }

  public connect(): void {
    if (this.isDisposed) return;
    this.onStatusChange?.('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.onStatusChange?.('live');
        this.startPing();
      };

      this.ws.onclose = () => {
        this.stopPing();
        this.onStatusChange?.('offline');
        if (!this.isDisposed) {
          this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
        }
      };

      this.ws.onerror = () => {
        this.onStatusChange?.('offline');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const reqId = typeof data.req_id === 'number' ? data.req_id : null;

          // Settle pending one-off request
          if (reqId !== null && this.pendingRequests.has(reqId)) {
            const p = this.pendingRequests.get(reqId)!;
            this.pendingRequests.delete(reqId);
            if (data.error) {
              const err = data.error as { message?: string };
              p.reject(new Error(err.message || 'Deriv API error'));
            } else {
              p.resolve(data);
            }
          }

          // Trigger subscription listeners
          if (data.subscription) {
            const sub = data.subscription as { id?: string };
            if (sub.id && this.subscriptionHandlers.has(sub.id)) {
              this.subscriptionHandlers.get(sub.id)!(data);
            }
          }

          // Message type based routing (e.g. tick, history, proposal_open_contract)
          const msgType = data.msg_type as string;
          if (msgType && this.subscriptionHandlers.has(msgType)) {
            this.subscriptionHandlers.get(msgType)!(data);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };
    } catch {
      this.onStatusChange?.('offline');
      this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
    }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const reqId = ++this.reqIdCounter;
    const msg = { ...payload, req_id: reqId };

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
  }
}
