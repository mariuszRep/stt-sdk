import { describe, it, expect } from "vitest";
import {
  createProvider,
  FasterWhisperProvider,
  WhisperCppProvider,
  OpenAIProvider,
  GroqProvider,
  UnsupportedCapabilityError,
} from "../src";
import { resolveFetch } from "../src/transport";

describe("resolveFetch — default must be safely callable as a method", () => {
  it("the default (no fetchImpl override) is bound, not the raw global reference", () => {
    // Regression test for a real production bug: every provider stores
    // resolveFetch()'s return value as `this.fetchImpl` and calls it as
    // `this.fetchImpl(...)` — a method call, not a bare `fetch(...)`
    // reference. Real browser/WebView `fetch` implementations are WebIDL
    // "platform objects" that brand-check their receiver and throw
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
    // the instant they're invoked with any receiver other than the realm
    // global — exactly what `this.fetchImpl(...)` does for an unbound
    // reference. Node's own global `fetch` (undici) does *not* enforce this
    // receiver check, so a test that actually calls the resolved function
    // can't reproduce the bug here — instead, this simulates the browser's
    // brand check directly against a stand-in `fetch`, which is the one
    // part of the real failure mode that's environment-independent: does
    // `resolveFetch` hand back something still tied to its original
    // receiver, or a plain unbound reference?
    let receiverAtCallTime: unknown;
    const fakeBrandCheckedFetch = function (this: unknown) {
      receiverAtCallTime = this;
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(new Response("ok"));
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeBrandCheckedFetch as typeof fetch;
    try {
      const resolved = resolveFetch({});
      const holder = { fetchImpl: resolved };
      expect(() => holder.fetchImpl("http://example.invalid")).not.toThrow();
      expect(receiverAtCallTime).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

  it("builds a batch-only FasterWhisperProvider even from a descriptor that still advertises a streaming block", async () => {
    // A stale/older stt-server build could still send a `streaming` block (or
    // one could reappear for a different runtime later) — the SDK must not
    // resurrect WS behavior from descriptor data alone. FasterWhisperProvider
    // is batch-only now; createStream() always rejects regardless of what the
    // descriptor advertised.
    const provider = createProvider({
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
    }) as FasterWhisperProvider;

    expect(provider).toBeInstanceOf(FasterWhisperProvider);
    expect(provider.capability.supportsStreaming).toBe(false);
    await expect(
      provider.createStream({ language: "en", model: "auto", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
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
