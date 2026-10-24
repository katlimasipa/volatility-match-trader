import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DerivWS } from "@/lib/deriv-ws";

/**
 * Mock WebSocket: DerivWS expects the standard event-handler surface.
 * The constructor connects immediately, so tests install this mock first.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((e?: unknown) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  /** Simulate the server accepting the connection. */
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Simulate an incoming Deriv message. */
  simulateMessage(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  lastSent(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1];
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}

function currentSocket(): MockWebSocket {
  const socket = (globalThis as { __lastMockWs?: MockWebSocket }).__lastMockWs;
  if (!socket) throw new Error("no mock socket created");
  return socket;
}

describe("DerivWS connection resilience", () => {
  beforeEach(() => {
    const OriginalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = class extends MockWebSocket {
      constructor() {
        super();
        (globalThis as { __lastMockWs?: MockWebSocket }).__lastMockWs = this;
        void OriginalWebSocket;
      }
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a pending request instead of hanging forever when Deriv never replies", async () => {
    vi.useFakeTimers();
    const ws = new DerivWS("wss://mock.test", undefined, { autoReconnect: false });
    currentSocket().simulateOpen();

    const pending = ws.send({ ping: 1 }, 5000);
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    ws.dispose();
  });

  it("resolves a pending request when Deriv replies", async () => {
    const ws = new DerivWS("wss://mock.test", undefined, { autoReconnect: false });
    currentSocket().simulateOpen();

    const pending = ws.send<{ pong: number }>({ ping: 1 });
    const sent = currentSocket().lastSent();
    currentSocket().simulateMessage({ pong: 1, req_id: sent.req_id });
    await expect(pending).resolves.toEqual({ pong: 1, req_id: sent.req_id });
    ws.dispose();
  });

  it("resubscribes active tick subscriptions automatically after a reconnect", async () => {
    vi.useFakeTimers();
    const ws = new DerivWS("wss://mock.test", undefined, { autoReconnect: true });
    currentSocket().simulateOpen();
    await ws.send({ ticks_history: "R_100", count: 1000, subscribe: 1 });

    // Connection drops, DerivWS waits 2.5s and reconnects, then resubscribes.
    currentSocket().close();
    await vi.advanceTimersByTimeAsync(3000);
    currentSocket().simulateOpen();
    currentSocket().simulateMessage({ echo_req: { ticks_history: "R_100" }, req_id: 999 });

    const resub = currentSocket().lastSent();
    expect(resub.ticks_history).toBe("R_100");
    expect(resub.subscribe).toBe(1);
    ws.dispose();
  });
});
