import { describe, it, expect, vi } from "vitest";
import { SttServerProvider } from "../src/providers/stt-server";
import {
  AdminRequiredError,
  ConnectionError,
  ModelLoadingError,
  ModelNotInstalledError,
  NetworkNotPrivateError,
  ServerBusyError,
  ServerError,
  ServerNotReadyError,
  ServerUnsupportedCapabilityError,
  ServerVersionError,
  UnauthorizedError,
  UnsupportedCapabilityError,
} from "../src/errors";

const HEALTH_OK = {
  status: "ok",
  service: "stt-server",
  version: "0.1.0",
  api_level: 1,
};

const MODELS_RESPONSE = {
  object: "list",
  data: [
    {
      id: "whisper-tiny",
      object: "model",
      owned_by: "local",
      default: true,
      capabilities: {
        prompt: { status: "supported" },
        language_hint: { status: "supported" },
        translation: { status: "supported" },
        temperature: { status: "supported" },
        timestamp_granularity: { status: "supported" },
        word_timestamps: { status: "supported" },
      },
    },
    {
      id: "no-frills-model",
      object: "model",
      owned_by: "local",
      default: false,
      capabilities: {
        prompt: { status: "unsupported" },
        language_hint: { status: "unknown" },
        translation: { status: "unsupported" },
        temperature: { status: "unknown" },
        timestamp_granularity: { status: "unsupported" },
        word_timestamps: { status: "unsupported" },
      },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Capture {
  url: string;
  init?: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];

/** Routes fetch by suffix; each handler returns the next Response for that path. */
function mockFetch(
  captures: Capture[],
  routes: Record<string, () => Response>,
): typeof fetch {
  return vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const url = String(input);
    captures.push({ url, init });
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    throw new Error(`Unhandled route in mockFetch: ${url}`);
  }) as unknown as typeof fetch;
}

function makeProvider(routes: Record<string, () => Response>, captures: Capture[] = []) {
  return new SttServerProvider({
    baseUrl: "http://127.0.0.1:54321",
    token: "test-token",
    fetchImpl: mockFetch(captures, routes),
  });
}

describe("SttServerProvider — version check", () => {
  it("passes with a matching service and sufficient api_level", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
      },
      captures,
    );
    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(captures[0]!.url).toBe("http://127.0.0.1:54321/health");
  });

  it("throws ServerVersionError(not_stt_server) for a wrong service", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse({ status: "ok", service: "something-else", api_level: 1 }),
    });
    const err = await provider.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ServerVersionError);
    expect(err.code).toBe("not_stt_server");
  });

  it("throws ServerVersionError(server_too_old) for an insufficient api_level", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse({ status: "ok", service: "stt-server", api_level: 0 }),
    });
    const err = await provider.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ServerVersionError);
    expect(err.code).toBe("server_too_old");
  });

  it("wraps a network failure on /health as ConnectionError", async () => {
    const provider = new SttServerProvider({
      baseUrl: "http://127.0.0.1:54321",
      token: "test-token",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(provider.listModels()).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("SttServerProvider — listModels mapping", () => {
  it("maps default flag and derives conservative capability booleans", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () => jsonResponse(MODELS_RESPONSE),
    });
    const models = await provider.listModels();

    const tiny = models.find((m) => m.id === "whisper-tiny")!;
    expect(tiny.isDefault).toBe(true);
    expect(tiny.capabilities).toEqual({
      prompt: true,
      languageHint: true,
      languageDetect: false,
      translation: true,
      streaming: false,
      temperature: true,
      timestamps: { segment: true, word: true },
    });

    const plain = models.find((m) => m.id === "no-frills-model")!;
    expect(plain.isDefault).toBe(false);
    // "unknown" is treated the same as "unsupported" — never sent.
    expect(plain.capabilities).toEqual({
      prompt: false,
      languageHint: false,
      languageDetect: false,
      translation: false,
      streaming: false,
      temperature: false,
      timestamps: { segment: false, word: false },
    });
  });

  it("prefers top-level languages/language_detect fields (0.1.1+)", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () =>
        jsonResponse({
          object: "list",
          data: [
            {
              id: "whisper-tiny",
              object: "model",
              owned_by: "local",
              default: true,
              languages: ["en", "es"],
              language_detect: true,
              capabilities: {
                language_hint: { status: "supported", languages: ["en"] },
                language_detect: { status: "unsupported" },
              },
            },
          ],
        }),
    });
    const models = await provider.listModels();
    const tiny = models.find((m) => m.id === "whisper-tiny")!;
    expect(tiny.languages).toEqual(["en", "es"]);
    // Top-level language_detect wins over the (contradictory) capability status.
    expect(tiny.capabilities?.languageDetect).toBe(true);
  });

  it("falls back to capabilities.language_hint.extra.languages/model_claim and language_detect status", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () =>
        jsonResponse({
          object: "list",
          data: [
            {
              id: "live-model",
              object: "model",
              owned_by: "local",
              default: false,
              capabilities: {
                language_hint: { status: "supported", extra: { languages: ["en", "no"] } },
                language_detect: { status: "supported" },
              },
            },
            {
              id: "catalog-model",
              object: "model",
              owned_by: "local",
              default: false,
              capabilities: {
                language_hint: { status: "unknown", model_claim: ["en", "fr"] },
                language_detect: { status: "unknown" },
              },
            },
          ],
        }),
    });
    const models = await provider.listModels();

    const live = models.find((m) => m.id === "live-model")!;
    expect(live.languages).toEqual(["en", "no"]);
    expect(live.capabilities?.languageDetect).toBe(true);

    const catalog = models.find((m) => m.id === "catalog-model")!;
    expect(catalog.languages).toEqual(["en", "fr"]);
    expect(catalog.capabilities?.languageDetect).toBe(false);
    // The catalog's list of languages is enough to send the hint; an unknown status with no list is not.
    expect(catalog.capabilities?.languageHint).toBe(true);
    expect(live.capabilities?.languageHint).toBe(true);
  });

  it("maps the server's name field through when present", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () =>
        jsonResponse({
          object: "list",
          data: [
            {
              id: "whisper-tiny",
              object: "model",
              owned_by: "local",
              default: true,
              name: "Whisper Tiny (fast)",
            },
          ],
        }),
    });
    const models = await provider.listModels();
    const tiny = models.find((m) => m.id === "whisper-tiny")!;
    expect(tiny.name).toBe("Whisper Tiny (fast)");
  });

  it("falls back to id as name when the server omits or blanks name", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () =>
        jsonResponse({
          object: "list",
          data: [
            { id: "no-name-model", object: "model", owned_by: "local", default: false },
            { id: "blank-name-model", object: "model", owned_by: "local", default: false, name: "" },
            { id: "whitespace-name-model", object: "model", owned_by: "local", default: false, name: "   " },
          ],
        }),
    });
    const models = await provider.listModels();
    expect(models.find((m) => m.id === "no-name-model")!.name).toBe("no-name-model");
    expect(models.find((m) => m.id === "blank-name-model")!.name).toBe("blank-name-model");
    expect(models.find((m) => m.id === "whitespace-name-model")!.name).toBe("whitespace-name-model");
  });
});

describe("SttServerProvider — transcribe", () => {
  it("sends model, prompt, language, temperature and word timestamps when supported", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
        "/v1/audio/transcriptions": () =>
          jsonResponse({ text: "hello", language: "en", duration: 1.5 }),
      },
      captures,
    );

    await provider.transcribe({
      file: new Uint8Array([1, 2, 3]),
      model: "whisper-tiny",
      prompt: "some vocabulary",
      language: "en",
      temperature: 0.2,
      wordTimestamps: true,
    });

    const transcribeCall = captures.find((c) => c.url.endsWith("/v1/audio/transcriptions"))!;
    const form = transcribeCall.init!.body as FormData;
    expect(form.get("model")).toBe("whisper-tiny");
    expect(form.get("prompt")).toBe("some vocabulary");
    expect(form.get("language")).toBe("en");
    expect(form.get("temperature")).toBe("0.2");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("timestamp_granularities")).toBe("word");
  });

  it("drops prompt, language, temperature and timestamps for a model that doesn't support them", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
        "/v1/audio/transcriptions": () => jsonResponse({ text: "hi" }),
      },
      captures,
    );

    await provider.transcribe({
      file: new Uint8Array([1, 2, 3]),
      model: "no-frills-model",
      prompt: "ignored",
      language: "en",
      temperature: 0.2,
      wordTimestamps: true,
    });

    const transcribeCall = captures.find((c) => c.url.endsWith("/v1/audio/transcriptions"))!;
    const form = transcribeCall.init!.body as FormData;
    expect(form.get("model")).toBe("no-frills-model");
    expect(form.get("prompt")).toBeNull();
    expect(form.get("language")).toBeNull();
    expect(form.get("temperature")).toBeNull();
    expect(form.get("response_format")).toBeNull();
    expect(form.get("timestamp_granularities")).toBeNull();
  });

  it("omits model field when none is given (server default resolves)", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
        "/v1/audio/transcriptions": () => jsonResponse({ text: "hi" }),
      },
      captures,
    );

    await provider.transcribe({ file: new Uint8Array([1, 2, 3]) });

    const transcribeCall = captures.find((c) => c.url.endsWith("/v1/audio/transcriptions"))!;
    const form = transcribeCall.init!.body as FormData;
    expect(form.get("model")).toBeNull();
  });

  it("maps the response, including segments/words and x_diagnostics", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () => jsonResponse(MODELS_RESPONSE),
      "/v1/audio/transcriptions": () =>
        jsonResponse({
          text: "hello world",
          language: "en",
          duration: 1.5,
          segments: [
            {
              text: "hello world",
              start: 0,
              end: 1.5,
              avg_logprob: -0.2,
              no_speech_prob: 0.01,
              compression_ratio: 1.1,
              words: [{ word: "hello", start: 0, end: 0.6, probability: 0.98 }],
            },
          ],
          x_diagnostics: { queue_wait_ms: 5, model: "whisper-tiny" },
        }),
    });

    const result = await provider.transcribe({ file: new Uint8Array([1, 2, 3]) });

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.durationMs).toBe(1500);
    expect(result.segments).toEqual([
      {
        text: "hello world",
        startMs: 0,
        endMs: 1500,
        avgLogprob: -0.2,
        noSpeechProb: 0.01,
        compressionRatio: 1.1,
        words: [{ word: "hello", startMs: 0, endMs: 600, probability: 0.98 }],
      },
    ]);
    expect(result.diagnostics).toEqual({ queue_wait_ms: 5, model: "whisper-tiny" });
  });
});

describe("SttServerProvider — translate", () => {
  it("posts to /v1/audio/translations when the model supports translation", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
        "/v1/audio/translations": () => jsonResponse({ text: "translated" }),
      },
      captures,
    );

    const result = await provider.translate({ file: new Uint8Array([1]), model: "whisper-tiny" });
    expect(result.text).toBe("translated");
    expect(captures.some((c) => c.url.endsWith("/v1/audio/translations"))).toBe(true);
  });

  it("throws UnsupportedCapabilityError when the model doesn't support translation", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () => jsonResponse(MODELS_RESPONSE),
    });

    await expect(
      provider.translate({ file: new Uint8Array([1]), model: "no-frills-model" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe("SttServerProvider — translation targets", () => {
  const translating = (target_languages: string[] | null | undefined, status = "supported") => ({
    status,
    ...(target_languages === undefined ? {} : { target_languages }),
  });
  const modelsWith = (translation: Record<string, unknown>) => ({
    object: "list",
    data: [{ id: "m", default: true, capabilities: { translation, language_hint: { status: "supported" } } }],
  });
  const providerFor = (translation: Record<string, unknown>, captures: Capture[] = []) =>
    makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(modelsWith(translation)),
        "/v1/audio/translations": () => jsonResponse({ text: "translated" }),
      },
      captures,
    );
  const posted = (captures: Capture[]) => captures.filter((c) => c.url.endsWith("/v1/audio/translations"));
  const sentTarget = (capture: Capture) => (capture.init?.body as FormData).get("target_language");
  const audio = new Uint8Array([1]);

  it("reads the model's own target list, and nothing when it does not advertise one", async () => {
    const targets = async (translation: Record<string, unknown>) =>
      (await providerFor(translation).listModels())[0]!.capabilities!.translationTargets;
    expect(await targets(translating(["en", "de"]))).toEqual(["en", "de"]);
    expect(await targets(translating(null))).toBeUndefined();
    expect(await targets(translating([]))).toBeUndefined();
    expect(await targets(translating(["en"], "unknown"))).toBeUndefined();
  });

  it("lets a model translate that only the catalog claims translates, English only", async () => {
    // The catalog view of a model that is not loaded: unverified, and it does not say into what.
    const claimed = { status: "unknown", model_claim: true, target_languages: null };
    const caps = (await providerFor(claimed).listModels())[0]!.capabilities!;
    expect(caps.translation).toBe(true);
    expect(caps.translationTargets).toBeUndefined();
    const captures: Capture[] = [];
    const provider = providerFor(claimed, captures);
    await provider.translate({ file: audio });
    expect(posted(captures)).toHaveLength(1);
    await expect(provider.translate({ file: audio, targetLanguage: "de" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    const denied = { status: "unsupported", model_claim: false, target_languages: [] };
    expect((await providerFor(denied).listModels())[0]!.capabilities!.translation).toBe(false);
  });

  it("sends target_language for a target the model offers", async () => {
    const captures: Capture[] = [];
    const provider = providerFor(translating(["en", "de"]), captures);
    const result = await provider.translate({ file: audio, targetLanguage: " de " });
    expect(result.text).toBe("translated");
    expect(sentTarget(posted(captures)[0]!)).toBe("de");
  });

  it("leaves the field out for English, the endpoint's default, so older servers keep working", async () => {
    const captures: Capture[] = [];
    const provider = providerFor(translating(["en", "de"]), captures);
    await provider.translate({ file: audio });
    await provider.translate({ file: audio, targetLanguage: "en" });
    expect(posted(captures)).toHaveLength(2);
    expect(posted(captures).map(sentTarget)).toEqual([null, null]);
  });

  it("refuses a target the model does not offer, without posting", async () => {
    const captures: Capture[] = [];
    const provider = providerFor(translating(["en", "de"]), captures);
    const error = await provider.translate({ file: audio, targetLanguage: "fr" }).catch((e) => e);
    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error.message).toContain("en, de");
    expect(posted(captures)).toHaveLength(0);
  });

  it("treats a translating model with no advertised list as English only", async () => {
    const captures: Capture[] = [];
    const provider = providerFor(translating(null), captures);
    await expect(provider.translate({ file: audio, targetLanguage: "de" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    await provider.translate({ file: audio, targetLanguage: "en" });
    expect(posted(captures)).toHaveLength(1);
  });

  it("does not refuse a target equal to the source language, which the server transcribes", async () => {
    const captures: Capture[] = [];
    const provider = providerFor(translating(["en"]), captures);
    await provider.translate({ file: audio, language: "fr-FR", targetLanguage: "fr" });
    expect(sentTarget(posted(captures)[0]!)).toBe("fr");
  });

  it("passes the server's unsupported_target_language through with its code", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () => jsonResponse(modelsWith(translating(["en", "de"]))),
      "/v1/audio/translations": () =>
        jsonResponse({ error: { code: "unsupported_target_language", message: "no" } }, 422),
    });
    const error = await provider.translate({ file: audio, targetLanguage: "de" }).catch((e) => e);
    expect(error.code).toBe("unsupported_target_language");
    expect(error.status).toBe(422);
  });
});

describe("SttServerProvider — error mapping", () => {
  const cases: Array<{
    code: string;
    status: number;
    ctor: new (...args: any[]) => Error;
    retryable: boolean;
  }> = [
    { code: "server_not_ready", status: 503, ctor: ServerNotReadyError, retryable: false },
    { code: "model_loading", status: 503, ctor: ModelLoadingError, retryable: true },
    { code: "model_not_installed", status: 404, ctor: ModelNotInstalledError, retryable: false },
    {
      code: "unsupported_capability",
      status: 422,
      ctor: ServerUnsupportedCapabilityError,
      retryable: false,
    },
    { code: "queue_full", status: 429, ctor: ServerBusyError, retryable: true },
    { code: "engine_busy", status: 503, ctor: ServerBusyError, retryable: true },
    { code: "admin_required", status: 403, ctor: AdminRequiredError, retryable: false },
    { code: "unauthorized", status: 401, ctor: UnauthorizedError, retryable: false },
    {
      code: "network_not_private",
      status: 403,
      ctor: NetworkNotPrivateError,
      retryable: false,
    },
  ];

  for (const { code, status, ctor, retryable } of cases) {
    it(`maps "${code}" (${status}) to ${ctor.name} with retryable=${retryable}`, async () => {
      const provider = makeProvider({
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/models": () => jsonResponse(MODELS_RESPONSE),
        "/v1/audio/transcriptions": () =>
          jsonResponse({ error: { code, message: `boom: ${code}` } }, status),
      });

      const err = await provider
        .transcribe({ file: new Uint8Array([1]), model: "whisper-tiny" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ctor);
      expect(err.code).toBe(code === "engine_busy" || code === "queue_full" ? code : code);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
    });
  }

  it("passes an unrecognized server code through verbatim", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/models": () => jsonResponse(MODELS_RESPONSE),
      "/v1/audio/transcriptions": () =>
        jsonResponse({ error: { code: "some_future_code", message: "new thing" } }, 500),
    });

    const err = await provider
      .transcribe({ file: new Uint8Array([1]), model: "whisper-tiny" })
      .catch((e) => e);
    expect(err.code).toBe("some_future_code");
    expect(err.retryable).toBe(false);
  });
});

describe("SttServerProvider — detectSpeech", () => {
  const VAD_RESPONSE = {
    duration: 6.165,
    speech_seconds: 5.048,
    speech_ratio: 0.8188,
    segments: [
      { start: 0.258, end: 2.942 },
      { start: 3.074, end: 5.438 },
    ],
  };

  it("posts the audio to /v1/audio/vad with the bearer token and maps the response", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/audio/vad": () => jsonResponse(VAD_RESPONSE),
      },
      captures,
    );

    const result = await provider.detectSpeech(new Uint8Array([1, 2, 3]));

    expect(result).toEqual({
      segments: [
        { start: 0.258, end: 2.942 },
        { start: 3.074, end: 5.438 },
      ],
      speechRatio: 0.8188,
      duration: 6.165,
    });
    const call = captures.find((c) => c.url.endsWith("/v1/audio/vad"))!;
    expect(call.init!.method).toBe("POST");
    expect((call.init!.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const form = call.init!.body as FormData;
    expect((form.get("file") as File).name).toBe("recording.wav");
    // No model is involved, so the model list is never fetched; unset options are not sent.
    expect(captures.some((c) => c.url.endsWith("/v1/models"))).toBe(false);
    for (const field of ["threshold", "min_speech_ms", "min_silence_ms", "speech_pad_ms"]) {
      expect(form.has(field)).toBe(false);
    }
  });

  it("sends the options it is given", async () => {
    const captures: Capture[] = [];
    const provider = makeProvider(
      {
        "/health": () => jsonResponse(HEALTH_OK),
        "/v1/audio/vad": () => jsonResponse({ ...VAD_RESPONSE, segments: [] }),
      },
      captures,
    );

    const result = await provider.detectSpeech(new Blob(["x"]), {
      filename: "clip.wav",
      threshold: 0.6,
      minSpeechMs: 300,
      minSilenceMs: 150,
      speechPadMs: 40,
    });

    expect(result.segments).toEqual([]);
    const form = captures.find((c) => c.url.endsWith("/v1/audio/vad"))!.init!.body as FormData;
    expect((form.get("file") as File).name).toBe("clip.wav");
    expect(form.get("threshold")).toBe("0.6");
    expect(form.get("min_speech_ms")).toBe("300");
    expect(form.get("min_silence_ms")).toBe("150");
    expect(form.get("speech_pad_ms")).toBe("40");
  });

  it("passes the server's invalid_request_error through with its code and status", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/audio/vad": () =>
        jsonResponse(
          { error: { code: "invalid_request_error", message: "threshold must be between 0.05 and 0.95" } },
          400,
        ),
    });

    const err = await provider.detectSpeech(new Uint8Array([1]), { threshold: 2 }).catch((e) => e);

    expect(err).toBeInstanceOf(ServerError);
    expect(err.code).toBe("invalid_request_error");
    expect(err.status).toBe(400);
  });

  it("maps an unauthorized answer to UnauthorizedError", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse(HEALTH_OK),
      "/v1/audio/vad": () => jsonResponse({ error: { code: "unauthorized", message: "no" } }, 401),
    });

    await expect(provider.detectSpeech(new Uint8Array([1]))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("wraps a network failure as ConnectionError", async () => {
    const provider = new SttServerProvider({
      baseUrl: "http://127.0.0.1:54321",
      token: "test-token",
      fetchImpl: vi.fn(async (input: FetchInput) => {
        if (String(input).endsWith("/health")) return jsonResponse(HEALTH_OK);
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    await expect(provider.detectSpeech(new Uint8Array([1]))).rejects.toBeInstanceOf(ConnectionError);
  });
});
