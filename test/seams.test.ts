import { describe, it, expect, vi } from "vitest";
import {
  createProvider,
  LocalRuntimeProvider,
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
  // Deliberately inverted from this suite's pre-2026-09-09 behavior:
  // createProvider used to switch on descriptor.provider (accepting only
  // "faster-whisper"/"whisper-cpp" and throwing for anything else, mapping
  // to the named FasterWhisperProvider/WhisperCppProvider classes). It now
  // selects on descriptor.protocol alone — any "voice-typer-v1" descriptor
  // gets the same real LocalRuntimeProvider, regardless of what
  // descriptor.provider says, so a conformant runtime this SDK has never
  // heard the name of (sherpad's "sherpa-onnx", or anyone's own runtime)
  // works without an SDK release. See protocol-driven-local-provider's
  // goal file for the full rationale. Do not "fix" these assertions back.

  it("maps a voice-typer-v1 descriptor to LocalRuntimeProvider, using descriptor.provider only as a label", () => {
    const provider = createProvider({
      schemaVersion: 1,
      provider: "faster-whisper",
      protocol: "voice-typer-v1",
      transport: "http",
      baseUrl: "http://127.0.0.1:8000",
    });
    expect(provider).toBeInstanceOf(LocalRuntimeProvider);
    expect(provider.id).toBe("faster-whisper");
    expect(provider.capability.id).toBe("faster-whisper");
  });

  it("works for a provider name this SDK has never been told about (e.g. sherpa-onnx)", () => {
    // The whole point: adding a new engine on the stt-server side must
    // never require an SDK release. Nothing here names "sherpa-onnx"
    // anywhere in src/ — this descriptor's provider string could be
    // anything and still work, because dispatch is on protocol alone.
    const provider = createProvider({
      schemaVersion: 1,
      provider: "sherpa-onnx",
      protocol: "voice-typer-v1",
      transport: "http",
      baseUrl: "http://127.0.0.1:7891",
    });
    expect(provider).toBeInstanceOf(LocalRuntimeProvider);
    expect(provider.id).toBe("sherpa-onnx");
    expect(provider.capability.available).toBe(true);
    expect(provider.capability.supportsBatch).toBe(true);
  });

  it("a whisper-cpp descriptor now also gets a real, working LocalRuntimeProvider (not the stubbed WhisperCppProvider seam)", () => {
    // WhisperCppProvider (constructed directly — see the seams describe
    // block above) remains the deliberately-stubbed, always-throws class it
    // always was; it is simply no longer what createProvider returns for a
    // "whisper-cpp"-labeled descriptor, since dispatch no longer reads that
    // field at all.
    const provider = createProvider({
      schemaVersion: 1,
      provider: "whisper-cpp",
      protocol: "voice-typer-v1",
      transport: "http",
      baseUrl: "http://127.0.0.1:8001",
    });
    expect(provider).toBeInstanceOf(LocalRuntimeProvider);
    expect(provider).not.toBeInstanceOf(WhisperCppProvider);
  });

  it("builds a batch-only provider even from a descriptor that still advertises a streaming block", async () => {
    // A stale/older stt-server build could still send a `streaming` block (or
    // one could reappear for a different runtime later) — the SDK must not
    // resurrect WS behavior from descriptor data alone. Every local runtime
    // provider is batch-only today; createStream() always rejects regardless
    // of what the descriptor advertised.
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
    });

    expect(provider.capability.supportsStreaming).toBe(false);
    await expect(
      provider.createStream({ language: "en", model: "auto", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("FasterWhisperProvider remains directly constructible with its historical id/capability, for source compatibility", () => {
    const provider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
    expect(provider).toBeInstanceOf(FasterWhisperProvider);
    expect(provider).toBeInstanceOf(LocalRuntimeProvider);
    expect(provider.id).toBe("faster-whisper");
    expect(provider.capability.displayName).toBe("Faster Whisper (local)");
  });

  it("sends Authorization: Bearer <value> on every request when the descriptor carries a token, and no such header otherwise", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    }) as unknown as typeof fetch;

    const authed = createProvider(
      {
        schemaVersion: 1,
        provider: "sherpa-onnx",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://127.0.0.1:7891",
        auth: { type: "token", value: "secret-token" },
      },
      { fetchImpl },
    );
    await authed.transcribe({ file: new Uint8Array([1]) });
    expect((calls[0]?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer secret-token",
    );

    calls.length = 0;
    const unauthed = createProvider(
      {
        schemaVersion: 1,
        provider: "sherpa-onnx",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://127.0.0.1:7891",
      },
      { fetchImpl },
    );
    await unauthed.transcribe({ file: new Uint8Array([1]) });
    expect(calls[0]?.headers).toBeUndefined();
  });

  it("rejects unknown protocols and schema versions with typed errors; an unrecognized provider name alone is not rejected", () => {
    // An unrecognized *protocol* is a real wire-contract incompatibility —
    // still rejected. An unrecognized *provider name* is not (see the
    // "works for a provider name this SDK has never been told about" test
    // above) — that distinction is this goal's entire point.
    expect(() =>
      createProvider({
        schemaVersion: 1,
        provider: "unknown",
        protocol: "voice-typer-v1",
        transport: "http",
        baseUrl: "http://x",
      }),
    ).not.toThrow();

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
