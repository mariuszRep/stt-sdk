import { describe, it, expect, vi } from "vitest";
import { SttServerProvider } from "../src/providers/stt-server";
import { ConnectionError, UnsupportedCapabilityError } from "../src/errors";
import type { StreamConfig, TranscriptEvent } from "../src/types";
import { FakeWebSocket } from "./fake-websocket";

const HEALTH = { status: "ok", service: "stt-server", version: "0.3.3", api_level: 1 };

const MODELS = {
  object: "list",
  data: [
    { id: "parakeet-unified", default: true, capabilities: { streaming: { status: "supported" }, prompt: { status: "unsupported" } } },
    { id: "whisper-tiny", capabilities: { streaming: { status: "unsupported" } } },
    { id: "unconfirmed", capabilities: { streaming: { status: "unknown", model_claim: true, reason: "unverified" } } },
    { id: "unconfirmed-batch-only", capabilities: { streaming: { status: "unknown", model_claim: false } } },
    {
      id: "whisper-translate",
      capabilities: { streaming: { status: "unsupported" }, translation: { status: "supported", target_languages: ["en", "de"] } },
    },
  ],
};

const CONFIG: StreamConfig = { language: null, model: "parakeet-unified", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/**
 * A scripted stt-server: answers the REST routes and plays the server side of one `/v1/realtime` socket the way
 * client-contract.md section 5a describes it. `received` is every JSON frame the client sent.
 */
function mockServer() {
  const sockets: Array<{ url: string; headers: Record<string, string>; ws: FakeWebSocket; received: Array<Record<string, any>> }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/health")) return json(HEALTH);
    if (url.endsWith("/v1/models")) return json(MODELS);
    throw new Error(`unhandled ${url}`);
  }) as unknown as typeof fetch;
  const webSocketFactory = (url: string, headers: Record<string, string>) => {
    const ws = new FakeWebSocket(url);
    const entry = { url, headers, ws, received: [] as Array<Record<string, any>> };
    ws.send = (data) => void entry.received.push(JSON.parse(String(data)));
    sockets.push(entry);
    // The server greets every new connection with the session it created.
    queueMicrotask(() => {
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "transcription_session.created", session: { id: "sess_1" } }));
    });
    return ws as unknown as WebSocket;
  };
  const provider = new SttServerProvider({ baseUrl: "http://127.0.0.1:54321", token: "tok", fetchImpl, webSocketFactory });
  const say = (ws: FakeWebSocket, event: Record<string, unknown>) => ws.simulateMessage(JSON.stringify(event));
  /** Answers the client's session update, as the server does. */
  const accept = (ws: FakeWebSocket) => say(ws, { type: "transcription_session.updated", session: {} });
  return { provider, sockets, say, accept, fetchImpl };
}

async function open() {
  const server = mockServer();
  const opened = server.provider.createStream(CONFIG);
  // createStream awaits the REST calls; the socket appears once they are through.
  await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  const socket = server.sockets[0]!;
  await vi.waitFor(() => expect(socket.received).toHaveLength(1));
  server.accept(socket.ws);
  const session = await opened;
  const events: TranscriptEvent[] = [];
  session.onEvent = (e) => events.push(e);
  return { ...server, socket, session, events };
}

describe("SttServerProvider live streaming", () => {
  it("reads whether a model streams from its capabilities", async () => {
    const { provider } = mockServer();
    const models = await provider.listModels();
    expect(models.find((m) => m.id === "parakeet-unified")!.capabilities!.streaming).toBe(true);
    expect(models.find((m) => m.id === "whisper-tiny")!.capabilities!.streaming).toBe(false);
    expect(provider.capability.supportsStreaming).toBe(true);
  });

  it("counts a streaming model the engine has not confirmed yet when the catalog claims it", async () => {
    const { provider } = mockServer();
    const models = await provider.listModels();
    expect(models.find((m) => m.id === "unconfirmed")!.capabilities!.streaming).toBe(true);
    expect(models.find((m) => m.id === "unconfirmed-batch-only")!.capabilities!.streaming).toBe(false);
  });

  it("connects to /v1/realtime?intent=transcription with the bearer token and 16 kHz pcm16 settings", async () => {
    const { socket } = await open();
    const url = new URL(socket.url);
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("127.0.0.1:54321");
    expect(url.pathname).toBe("/v1/realtime");
    expect(url.searchParams.get("intent")).toBe("transcription");
    expect(url.searchParams.get("model")).toBe("parakeet-unified");
    expect(socket.headers.Authorization).toBe("Bearer tok");
    expect(socket.received[0]).toEqual({
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_sample_rate: 16000,
        input_audio_transcription: { model: "parakeet-unified" },
        turn_detection: null,
      },
    });
  });

  it("refuses a model that does not stream, before any socket opens, so the caller falls back to batch", async () => {
    const { provider, sockets } = mockServer();
    const error = await provider.createStream({ ...CONFIG, model: "whisper-tiny" }).catch((e) => e);
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(sockets).toHaveLength(0);
  });

  it("translates on a model that cannot stream, sending the target language with the session settings", async () => {
    const server = mockServer();
    const opened = server.provider.createStream({ ...CONFIG, model: "whisper-translate", targetLanguage: " de " });
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    const socket = server.sockets[0]!;
    await vi.waitFor(() => expect(socket.received).toHaveLength(1));
    expect(socket.received[0]!.session.input_audio_transcription).toEqual({
      model: "whisper-translate",
      target_language: "de",
    });
    server.accept(socket.ws);
    const session = await opened;
    const events: TranscriptEvent[] = [];
    session.onEvent = (e) => events.push(e);

    // The whole turn arrives at once after the commit, as the buffered turn path sends it.
    session.sendAudio(new Uint8Array(3200));
    const stopped = session.stop();
    expect(socket.received.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    server.say(socket.ws, { type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Hallo Welt" });
    await stopped;
    expect(events.filter((e) => e.type === "final")).toMatchObject([{ text: "Hallo Welt" }]);
  });

  it("refuses a translation the model cannot do, before any socket opens", async () => {
    const { provider, sockets } = mockServer();
    // A target the model does not offer, a model that does not translate at all, and one that streams but cannot translate.
    for (const config of [
      { ...CONFIG, model: "whisper-translate", targetLanguage: "fr" },
      { ...CONFIG, model: "whisper-tiny", targetLanguage: "en" },
      { ...CONFIG, model: "parakeet-unified", targetLanguage: "en" },
    ]) {
      expect(await provider.createStream(config).catch((e) => e)).toBeInstanceOf(UnsupportedCapabilityError);
    }
    expect(sockets).toHaveLength(0);
  });

  it("refuses audio that is not 16-bit mono PCM", async () => {
    const { provider } = mockServer();
    const error = await provider.createStream({ ...CONFIG, channels: 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("maps the server's streaming_unsupported error to UnsupportedCapabilityError", async () => {
    const server = mockServer();
    const opened = server.provider.createStream(CONFIG);
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    server.say(server.sockets[0]!.ws, { type: "error", error: { code: "streaming_unsupported", message: "no" } });
    expect(await opened.catch((e) => e)).toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("fails with a ConnectionError when the socket closes before the session is confirmed", async () => {
    const server = mockServer();
    const opened = server.provider.createStream(CONFIG);
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    server.sockets[0]!.ws.simulateClose(1006);
    expect(await opened.catch((e) => e)).toBeInstanceOf(ConnectionError);
  });

  it("sends audio as base64 pcm16 appends and counts the audio sent", async () => {
    const { session, socket, say, events } = await open();
    expect(session.state).toBe("active");
    expect(events).toEqual([]);
    session.sendAudio(new Uint8Array([1, 0, 2, 0, 3, 0]));
    expect(socket.received.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: Buffer.from([1, 0, 2, 0, 3, 0]).toString("base64") });
    say(socket.ws, { type: "conversation.item.input_audio_transcription.partial", item_id: "item_1", committed: "", tentative: "hel", revision: 1 });
    expect(events.at(-1)).toMatchObject({ type: "partial", id: "item_1", text: "hel", committed: "", tentative: "hel", revision: 1 });
  });

  it("holds audio sent before the server confirmed the session and flushes it in order", async () => {
    const server = mockServer();
    const opened = server.provider.createStream(CONFIG);
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    const socket = server.sockets[0]!;
    await vi.waitFor(() => expect(socket.received).toHaveLength(1));
    server.accept(socket.ws);
    const session = await opened;
    session.sendAudio(new Uint8Array([9, 0]));
    expect(socket.received.map((m) => m.type)).toEqual(["transcription_session.update", "input_audio_buffer.append"]);
  });

  it("shows committed text and the changing tentative text, and ends with the completed transcript on stop", async () => {
    const { session, socket, say, events } = await open();
    session.sendAudio(new Uint8Array(3200));
    say(socket.ws, { type: "conversation.item.input_audio_transcription.partial", item_id: "item_1", committed: "Okay", tentative: " stan", revision: 1 });
    say(socket.ws, { type: "conversation.item.input_audio_transcription.partial", item_id: "item_1", committed: "Okay Stanzo", tentative: " em", revision: 2 });
    const stopped = session.stop();
    expect(session.state).toBe("stopping");
    expect(socket.received.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    say(socket.ws, { type: "input_audio_buffer.committed", item_id: "item_1" });
    say(socket.ws, { type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Okay Stanzo email" });
    await stopped;
    expect(session.state).toBe("closed");
    expect(events.map((e) => e.type)).toEqual(["partial", "partial", "final", "closed"]);
    expect(events[2]).toMatchObject({ type: "final", id: "item_1", text: "Okay Stanzo email", endMs: 100 });
    expect(events[3]).toEqual({ type: "closed", reason: "client_stop" });
  });

  it("stops at once, with no commit, when no audio was sent", async () => {
    const { session, socket } = await open();
    await session.stop();
    expect(socket.received.map((m) => m.type)).toEqual(["transcription_session.update"]);
    expect(session.state).toBe("closed");
  });

  it("treats an empty commit as the end of the session", async () => {
    const { session, socket, say, events } = await open();
    session.sendAudio(new Uint8Array(2));
    const stopped = session.stop();
    say(socket.ws, { type: "error", error: { code: "input_audio_buffer_commit_empty", message: "empty" } });
    await stopped;
    expect(events.at(-1)).toEqual({ type: "closed", reason: "client_stop" });
  });

  it("discards the item with a clear on abort", async () => {
    const { session, socket, events } = await open();
    session.sendAudio(new Uint8Array(2));
    session.abort();
    expect(socket.received.at(-1)).toEqual({ type: "input_audio_buffer.clear" });
    expect(session.state).toBe("closed");
    expect(events.at(-1)).toEqual({ type: "closed", reason: "client_abort" });
  });

  it("reports server errors on a running session without ending it", async () => {
    const { session, socket, say, events } = await open();
    say(socket.ws, { type: "error", error: { code: "stream_busy", message: "busy" } });
    expect(events.at(-1)).toEqual({ type: "error", code: "stream_busy", message: "busy", retryable: false });
    expect(session.state).toBe("active");
  });

  it("reports a socket that drops under a running session as a retryable error and closes", async () => {
    const { session, socket, events } = await open();
    socket.ws.simulateClose(1006);
    expect(session.state).toBe("closed");
    expect(events.map((e) => e.type)).toEqual(["error", "closed"]);
    expect(events[0]).toMatchObject({ code: "connection_lost", retryable: true });
    expect(events[1]).toEqual({ type: "closed", reason: "error" });
  });

  it("ignores audio sent after stop", async () => {
    const { session, socket } = await open();
    session.sendAudio(new Uint8Array(2));
    void session.stop();
    const before = socket.received.length;
    session.sendAudio(new Uint8Array(2));
    expect(socket.received).toHaveLength(before);
  });
});
