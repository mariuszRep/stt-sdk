import { describe, it, expect, vi } from "vitest";
import { SttServerNextProvider } from "../src/providers/stt-server-next";
import {
  AdminRequiredError,
  ConnectionError,
  ModelLoadingError,
  ModelNotInstalledError,
  NetworkNotPrivateError,
  ServerBusyError,
  ServerNotReadyError,
  ServerUnsupportedCapabilityError,
  ServerVersionError,
  UnauthorizedError,
  UnsupportedCapabilityError,
} from "../src/errors";

const HEALTH_OK = {
  status: "ok",
  service: "stt-server-next",
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
  return new SttServerNextProvider({
    baseUrl: "http://127.0.0.1:54321",
    token: "test-token",
    fetchImpl: mockFetch(captures, routes),
  });
}

describe("SttServerNextProvider — version check", () => {
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

  it("throws ServerVersionError(not_stt_server_next) for a wrong service", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse({ status: "ok", service: "something-else", api_level: 1 }),
    });
    const err = await provider.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ServerVersionError);
    expect(err.code).toBe("not_stt_server_next");
  });

  it("throws ServerVersionError(server_too_old) for an insufficient api_level", async () => {
    const provider = makeProvider({
      "/health": () => jsonResponse({ status: "ok", service: "stt-server-next", api_level: 0 }),
    });
    const err = await provider.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ServerVersionError);
    expect(err.code).toBe("server_too_old");
  });

  it("wraps a network failure on /health as ConnectionError", async () => {
    const provider = new SttServerNextProvider({
      baseUrl: "http://127.0.0.1:54321",
      token: "test-token",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(provider.listModels()).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("SttServerNextProvider — listModels mapping", () => {
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

describe("SttServerNextProvider — transcribe", () => {
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

describe("SttServerNextProvider — translate", () => {
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

describe("SttServerNextProvider — error mapping", () => {
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
