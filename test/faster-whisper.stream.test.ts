import { describe, it, expect } from "vitest";
import { FasterWhisperProvider } from "../src/providers/faster-whisper";
import { ProtocolError } from "../src/errors";
import { createFakeWebSocketFactory } from "./fake-websocket";
import type { TranscriptEvent, SessionState } from "../src/types";
import streamEvents from "./fixtures/faster-whisper-stream-events.json";

const STREAM_CONFIG = {
  language: "en",
  model: "auto",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
} as const;

describe("FasterWhisperProvider — streaming protocol v1 (preserved from App voice-typer-ws-provider.ts)", () => {
  it("connects to WS /v1/audio/stream and sends the exact protocol v1 `start` message", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    const ws = instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:8000/v1/audio/stream");

    ws.simulateOpen();
    const startMessage = JSON.parse(ws.sent[0] as string);
    expect(startMessage).toEqual({
      type: "start",
      protocolVersion: 1,
      language: "en",
      model: "auto",
      encoding: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
      // prompt/auth omitted when not configured (JSON.stringify drops undefined)
    });

    ws.simulateMessage(JSON.stringify(streamEvents[0])); // ready
    const session = await startPromise;
    expect(session.state).toBe("active");
  });

  it("rejects createStream when the server sends a fatal error before ready", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    instances[0]!.simulateOpen();
    instances[0]!.simulateMessage(
      JSON.stringify({
        type: "error",
        code: "unsupported_protocol_version",
        message: "Server supports protocolVersion 1, got 2",
        retryable: false,
      }),
    );

    await expect(startPromise).rejects.toMatchObject({
      name: "ProtocolError",
      code: "unsupported_protocol_version",
      retryable: false,
    });
  });

  it("rejects createStream with ConnectionError when the socket errors", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    instances[0]!.simulateError();

    await expect(startPromise).rejects.toMatchObject({ name: "ConnectionError" });
  });

  it("forwards fixture events with unknown-field tolerance and keeps the session alive through non-fatal errors", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0])); // ready
    const session = await startPromise;

    const events: TranscriptEvent[] = [];
    session.onEvent = (event) => events.push(event);

    for (const event of streamEvents.slice(1)) {
      ws.simulateMessage(JSON.stringify(event));
    }

    // ready → partial → final → lagging → lagging → partial → error → final → closed → unknown
    expect(events.map((e) => e.type)).toEqual([
      "partial",
      "final",
      "lagging",
      "lagging",
      "partial",
      "error",
      "final",
      "closed",
      "heartbeat",
    ]);

    const [p1, f1, lag1, lag2, p2, err, f2, closed] = events as [
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
      TranscriptEvent,
    ];

    expect(p1).toMatchObject({ type: "partial", id: "seg-1", text: "hello wor", startMs: 0, endMs: 1200 });
    expect((p1 as { extraUnknownField?: string }).extraUnknownField).toBe("tolerated");
    expect(f1).toMatchObject({ type: "final", id: "seg-1", text: "hello world", startMs: 0, endMs: 1500 });
    expect(lag1).toMatchObject({ type: "lagging", active: true });
    expect(lag2).toMatchObject({ type: "lagging", active: false });
    expect(p2).toMatchObject({ type: "partial", id: "seg-2", text: "the quick brown" });
    expect(err).toMatchObject({ type: "error", code: "inference_failed", retryable: true });
    expect(f2).toMatchObject({ type: "final", id: "seg-2", text: "the quick brown fox" });
    expect(closed).toMatchObject({ type: "closed", reason: "client_stop" });

    // non-fatal error did not kill the session
    expect(session.state).toBe("active");
  });

  it("sends binary audio only after ready and flushes buffered audio on ready", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0])); // ready
    const session = await startPromise;

    expect(ws.sent.some((m) => m instanceof ArrayBuffer)).toBe(false);

    session.sendAudio(new Uint8Array([1, 2, 3]));
    session.sendAudio(new Uint8Array([4, 5, 6]));

    const binary = ws.sent.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer);
    expect(binary.map((b) => b.byteLength)).toEqual([3, 3]);
  });

  it("stop sends {type:'stop'}, transitions to stopping, and closes on server close", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0]));
    const session = await startPromise;

    const states: SessionState[] = [];
    session.onStateChange = (s) => states.push(s);

    await session.stop();

    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: "stop" });
    expect(session.state).toBe("stopping");

    ws.simulateClose();
    expect(session.state).toBe("closed");
    expect(states).toContain("stopping");
    expect(states).toContain("closed");
  });

  it("abort sends {type:'abort'} and emits a closed(client_abort) event", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      WebSocketImpl,
      stopTimeoutMs: 5000,
    });

    const startPromise = provider.createStream(STREAM_CONFIG);
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0]));
    const session = await startPromise;

    const events: TranscriptEvent[] = [];
    session.onEvent = (e) => events.push(e);

    session.abort();

    const textMessages = ws.sent.filter((m): m is string => typeof m === "string");
    expect(textMessages.some((m) => JSON.parse(m).type === "abort")).toBe(true);
    expect(session.state).toBe("closed");
    expect(events.at(-1)).toMatchObject({ type: "closed", reason: "client_abort" });
  });
});
