import { describe, it, expect } from "vitest";
import {
  createProvider,
  FasterWhisperProvider,
  WhisperCppProvider,
  OpenAIProvider,
  GroqProvider,
  UnsupportedCapabilityError,
} from "../src";
import { createFakeWebSocketFactory } from "./fake-websocket";

describe("Adapter seams — named entry points with explicit typed unsupported behavior", () => {
  const seams = [
    { name: "WhisperCppProvider", make: () => new WhisperCppProvider({ baseUrl: "http://127.0.0.1:8001" }) },
    { name: "OpenAIProvider", make: () => new OpenAIProvider({ apiKey: "k" }) },
    { name: "GroqProvider", make: () => new GroqProvider({ apiKey: "k" }) },
  ] as const;

  for (const { name, make } of seams) {
    it(`${name} reports an explicit unavailable capability and throws typed errors`, async () => {
      const provider = make();
      expect(provider.capability.available).toBe(false);
      expect(provider.capability.unavailableReason).toBeTruthy();

      await expect(provider.listModels()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      await expect(provider.transcribe({ file: new Uint8Array([1]) })).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
      await expect(
        provider.createStream({
          language: "en",
          model: "auto",
          encoding: "pcm_s16le",
          sampleRate: 16000,
          channels: 1,
        }),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    });
  }
});

describe("createProvider — runtime descriptor factory", () => {
  it("maps a faster-whisper descriptor to FasterWhisperProvider", () => {
    const provider = createProvider({
      schemaVersion: 1,
      provider: "faster-whisper",
      protocol: "voice-typer-v1",
      transport: "http",
      baseUrl: "http://127.0.0.1:8000",
    });
    expect(provider).toBeInstanceOf(FasterWhisperProvider);
    expect(provider.id).toBe("faster-whisper");
  });

  it("maps a whisper-cpp descriptor to the WhisperCppProvider seam", () => {
    const provider = createProvider({
      schemaVersion: 1,
      provider: "whisper-cpp",
      protocol: "voice-typer-v1",
      transport: "http",
      baseUrl: "http://127.0.0.1:8001",
    });
    expect(provider).toBeInstanceOf(WhisperCppProvider);
  });

  it("honors descriptor streaming endpoint and auth on the built provider", async () => {
    const { WebSocketImpl, instances } = createFakeWebSocketFactory();
    const provider = createProvider(
      {
        schemaVersion: 1,
        provider: "faster-whisper",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://127.0.0.1:8000",
        streaming: {
          enabled: true,
          endpoint: "/v1/audio/stream",
          protocolVersion: 1,
          encodings: ["pcm_s16le"],
          sampleRates: [16000],
          resample: true,
          channels: [1],
        },
        auth: { type: "token", value: "secret-token" },
      },
      { WebSocketImpl },
    ) as FasterWhisperProvider;

    const startPromise = provider.createStream({
      language: "en",
      model: "auto",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    });
    const ws = instances[0]!;
    ws.simulateOpen();
    const startMessage = JSON.parse(ws.sent[0] as string) as Record<string, unknown>;
    expect(startMessage.auth).toBe("secret-token");
    expect(ws.url).toBe("ws://127.0.0.1:8000/v1/audio/stream");
    ws.simulateMessage(JSON.stringify({ type: "ready", sessionId: "s", provider: "faster-whisper", protocolVersion: 1, model: "m", language: "en", sampleRate: 16000, channels: 1 }));
    await startPromise;
  });

  it("rejects unknown protocols, providers, and schema versions with typed errors", () => {
    expect(() =>
      createProvider({
        schemaVersion: 1,
        provider: "unknown",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://x",
      }),
    ).toThrow(UnsupportedCapabilityError);

    expect(() =>
      createProvider({
        schemaVersion: 1,
        provider: "faster-whisper",
        protocol: "future-protocol",
        transport: "http",
        baseUrl: "http://x",
      }),
    ).toThrow(UnsupportedCapabilityError);

    expect(() =>
      createProvider({
        schemaVersion: 99,
        provider: "faster-whisper",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://x",
      } as unknown as Parameters<typeof createProvider>[0]),
    ).toThrow(UnsupportedCapabilityError);
  });
});
