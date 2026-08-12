/**
 * Minimal in-memory WebSocket double for fixture-based contract tests.
 *
 * Implements only the surface the SDK sessions use (on* handlers, readyState,
 * binaryType, send, close) plus test drivers to simulate the server side.
 */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  binaryType: "blob" | "arraybuffer" = "blob";
  readyState: number = FakeWebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;

  sent: Array<string | ArrayBuffer> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ── Test drivers ────────────────────────────────────────────────────────

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  simulateError(): void {
    this.onerror?.();
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

/** Create an injected `WebSocket` constructor that records every instance. */
export function createFakeWebSocketFactory(): {
  WebSocketImpl: typeof WebSocket;
  instances: FakeWebSocket[];
} {
  const instances: FakeWebSocket[] = [];
  const WebSocketImpl = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  } as unknown as typeof WebSocket;
  return { WebSocketImpl, instances };
}
