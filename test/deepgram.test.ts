import { describe, it, expect, vi } from "vitest";
import { DeepgramProvider } from "../src/providers/deepgram";
import { ApiError, ConnectionError } from "../src/errors";
import { createFakeWebSocketFactory } from "./fake-websocket";
import type { TranscriptEvent, FinalEvent } from "../src/types";
import batchFixture from "./fixtures/deepgram-batch-response.json";
import modelsFixture from "./fixtures/deepgram-models-response.json";
import streamEvents from "./fixtures/deepgram-stream-events.json";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DeepgramProvider — batch REST contract (cloud proof, no server)", () => {
  it("POSTs multipart `audio` to /v1/listen with auth + query params and normalizes the result", async () => {
    const captures: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captures.push({ url: String(input), init });
      return jsonResponse(batchFixture);
    }) as unknown as typeof fetch;

    const provider = new DeepgramProvider({ apiKey: "test-key", fetchImpl });
    const result = await provider.transcribe({
      file: new Uint8Array([1, 2, 3]),
      filename: "clip.wav",
      model: "nova-2",
      language: "en",
    });

    const url = new URL(captures[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(captures[0]!.init?.method).toBe("POST");
    expect((captures[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      "Token test-key",
    );

    const form = captures[0]!.init!.body as FormData;
    expect((form.get("audio") as File).name).toBe("clip.wav");

    expect(result).toEqual({
      text: "Hello world from Deepgram.",
      durationMs: 2400,
      segments: [
        { text: "Hello", startMs: 0, endMs: 500, probability: 0.99 },
        { text: "world", startMs: 500, endMs: 1000, probability: 0.97 },
      ],
    });
  });

  it("throws ApiError on non-ok responses and ConnectionError on network failure", async () => {
    const failing = new DeepgramProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "bad" }, 400)) as unknown as typeof fetch,
    });
    await expect(failing.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });

    const offline = new DeepgramProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(offline.transcribe({ file: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  it("listModels maps the models catalog", async () => {
    const provider = new DeepgramProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => jsonResponse(modelsFixture)) as unknown as typeof fetch,
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["nova-2", "nova-3", "whisper-large"]);
  });
});

describe("DeepgramProvider — streaming WS contract (cloud proof, no server)", () => {
  it("connects with token + config query params and maps Metadata/Results/Error events", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new DeepgramProvider({ apiKey: "test-key", WebSocketImpl, stopTimeoutMs: 5000 });

    const startPromise = provider.createStream({
      language: "en",
      model: "nova-2",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
    const ws = instances[0]!;

    const url = new URL(ws.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("token")).toBe("test-key");
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.get("interim_results")).toBe("true");

    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0])); // Metadata → ready
    const session = await startPromise;
    expect(session.state).toBe("active");

    const events: TranscriptEvent[] = [];
    session.onEvent = (e) => events.push(e);

    // Audio after ready is sent as binary.
    session.sendAudio(new Uint8Array([9, 9, 9]));
    expect(ws.sent.some((m) => m instanceof ArrayBuffer && m.byteLength === 3)).toBe(true);

    ws.simulateMessage(JSON.stringify(streamEvents[1])); // Results is_final=false
    ws.simulateMessage(JSON.stringify(streamEvents[2])); // Results is_final=true (with words)
    ws.simulateMessage(JSON.stringify(streamEvents[3])); // Error

    expect(events[0]).toMatchObject({
      type: "partial",
      id: "dg-1",
      text: "hello wor",
      startMs: 0,
      endMs: 1100,
    });
    expect(events[1]).toMatchObject({
      type: "final",
      id: "dg-1", // final supersedes the partial with the same id
      text: "hello world",
      startMs: 0,
      endMs: 1500,
    });
    expect((events[1] as FinalEvent).words).toEqual([
      { word: "hello", startMs: 0, endMs: 700, probability: 0.98 },
      { word: "world", startMs: 700, endMs: 1500, probability: 0.94 },
    ]);
    expect(events[2]).toMatchObject({
      type: "error",
      code: "server_error",
      message: "Something went wrong",
      retryable: false,
    });
  });

  it("stop sends CloseStream; abort closes and emits closed(client_abort)", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new DeepgramProvider({ apiKey: "test-key", WebSocketImpl, stopTimeoutMs: 5000 });

    const startPromise = provider.createStream({
      language: "en",
      model: "nova-2",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify(streamEvents[0])); // Metadata → ready
    const session = await startPromise;

    await session.stop();
    expect(
      ws.sent.some((m) => typeof m === "string" && (JSON.parse(m) as { type: string }).type === "CloseStream"),
    ).toBe(true);

    const session2Start = provider.createStream({
      language: "en",
      model: "nova-2",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
    const ws2 = instances[1]!;
    ws2.simulateOpen();
    ws2.simulateMessage(JSON.stringify(streamEvents[0]));
    const session2 = await session2Start;
    const events: TranscriptEvent[] = [];
    session2.onEvent = (e) => events.push(e);

    session2.abort();
    expect(session2.state).toBe("closed");
    expect(events.at(-1)).toMatchObject({ type: "closed", reason: "client_abort" });
  });

  it("rejects createStream when Deepgram sends an Error before Metadata", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = new DeepgramProvider({ apiKey: "test-key", WebSocketImpl, stopTimeoutMs: 5000 });

    const startPromise = provider.createStream({
      language: "en",
      model: "nova-2",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
    instances[0]!.simulateMessage(JSON.stringify(streamEvents[3]));

    await expect(startPromise).rejects.toMatchObject({
      name: "ProtocolError",
      code: "server_error",
    });
  });
});
