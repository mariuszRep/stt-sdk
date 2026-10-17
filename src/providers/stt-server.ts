import type { SttProvider } from "../provider";
import type {
  BatchTranscriptionRequest,
  BatchTranslationRequest,
  ModelCapabilities,
  ModelInfo,
  ProviderCapability,
  SpeechDetectionOptions,
  SpeechDetectionResult,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptWord,
} from "../types";
import type { TransportDeps } from "../transport";
import { resolveFetch, resolveWebSocket, toBlob } from "../transport";
import { SttServerStreamSession, type WebSocketFactory } from "./stt-server-stream";
import {
  AdminRequiredError,
  ApiError,
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
} from "../errors";

export interface SttServerProviderOptions extends TransportDeps {
  /** Base URL of the stt-server instance, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  /** Bearer token (admin or user token — see the server's client contract, section 3). */
  token: string;
  /**
   * How the live socket is opened (`createStream`). The default passes the bearer header to the platform's
   * `WebSocket` (Node); a browser or webview cannot set it and supplies a factory of its own.
   */
  webSocketFactory?: WebSocketFactory;
}

/** Minimum `api_level` (see `/health`) this adapter requires. */
const MIN_API_LEVEL = 1;
const EXPECTED_SERVICE = "stt-server";

interface ControlCapability {
  status?: "supported" | "unsupported" | "unknown" | string;
  /** What the catalog claims for the model, before the loaded engine has confirmed it (an `"unknown"` status). */
  model_claim?: unknown;
  /** `translation` only: the languages the model translates into; `null` when it translates but does not say. */
  target_languages?: string[] | null;
}

/**
 * `language_hint`'s extra fields (client-contract.md §4.1): the live
 * `EffectiveCaps` view flattens its per-control extras (here, `languages`)
 * directly onto the control object; the catalog (unloaded) view instead
 * reports its static claim under `model_claim`. Some server versions may
 * nest either under an `extra` object, so both shapes are accepted.
 */
interface LanguageHintCapability extends ControlCapability {
  languages?: string[];
  model_claim?: string[];
  extra?: { languages?: string[]; model_claim?: string[] };
}

interface ServerModelEntry {
  id: string;
  /** Friendly display name (catalog name, custom_name, or derived); added in a later server version. */
  name?: string;
  object?: string;
  owned_by?: string;
  default?: boolean;
  capabilities?: Record<string, ControlCapability> & { language_hint?: LanguageHintCapability };
  /** Top-level convenience fields added in stt-server 0.1.1. */
  languages?: string[];
  language_detect?: boolean;
}

interface ServerModelsList {
  object?: string;
  data?: ServerModelEntry[];
}

interface ServerHealth {
  status?: string;
  service?: string;
  version?: string;
  api_level?: number;
}

interface ServerErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

interface ServerTranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

interface ServerTranscriptionSegment {
  text: string;
  start: number;
  end: number;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  words?: ServerTranscriptionWord[];
}

interface ServerTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: ServerTranscriptionSegment[];
  x_diagnostics?: Record<string, unknown>;
}

interface ServerSpeechDetectionResponse {
  duration: number;
  speech_seconds: number;
  speech_ratio: number;
  segments: Array<{ start: number; end: number }>;
}

/**
 * Derives the SDK's simple supported/not-supported {@link ModelCapabilities}
 * booleans from stt-server's richer per-control status values
 * (`"supported" | "unsupported" | "unknown"`, see client-contract.md §4.1).
 *
 * Rule: a control counts as supported only when the server explicitly says
 * `"supported"`. `"unknown"` (an unverified catalog claim, before any engine
 * has looked at the loaded file) and `"unsupported"` are both treated as
 * *not* supported — the SDK never sends an optional field it cannot confirm
 * the model accepts, per the contract's "clients omit unsupported or unknown
 * controls" rule (§4.3). Once the model has actually been loaded, the
 * server's live view replaces `"unknown"` with a verified answer, and this
 * mapping picks that up automatically on the next `listModels`/cache refresh.
 */
function deriveCapabilities(
  raw: (Record<string, ControlCapability> & { language_hint?: LanguageHintCapability }) | undefined,
): ModelCapabilities {
  const supported = (control?: ControlCapability): boolean => control?.status === "supported";
  const translationTargets = supported(raw?.translation) ? raw?.translation?.target_languages : undefined;
  return {
    prompt: supported(raw?.prompt),
    languageHint: supported(raw?.language_hint),
    languageDetect: supported(raw?.language_detect),
    translation: supported(raw?.translation),
    // Only a non-empty list is a real answer: `null` is "not advertised" (English only) and `[]` is "none".
    ...(translationTargets?.length ? { translationTargets } : {}),
    streaming: canStream(raw?.streaming),
    temperature: supported(raw?.temperature),
    timestamps: {
      // `timestamp_granularity` gates `timestamp_granularities=segment`; `word_timestamps`
      // gates the `word` value specifically (client-contract.md §4.1, §4.3).
      segment: supported(raw?.timestamp_granularity),
      word: supported(raw?.word_timestamps),
    },
  };
}

/**
 * Whether a model can transcribe live. Unlike the other controls, an unconfirmed (`"unknown"`) status counts when the
 * catalog claims streaming: nothing is sent that a model could reject, and a model that cannot stream is refused with
 * `streaming_unsupported` when the stream opens, which the caller answers by transcribing in batch. Waiting for the
 * engine to confirm would make the first recording after a start always batch.
 */
function canStream(control?: ControlCapability): boolean {
  return control?.status === "supported" || (control?.status === "unknown" && control.model_claim === true);
}

/**
 * The model's supported language codes: prefers the top-level `languages`
 * field (stt-server 0.1.1+), falling back to `capabilities.language_hint`'s
 * live `languages` or catalog `model_claim` (see {@link LanguageHintCapability}).
 */
function deriveLanguages(entry: ServerModelEntry): string[] | undefined {
  if (Array.isArray(entry.languages)) return entry.languages;
  const hint = entry.capabilities?.language_hint;
  return hint?.languages ?? hint?.extra?.languages ?? hint?.model_claim ?? hint?.extra?.model_claim;
}

/** The primary language subtag: `en-US` and `en_us` are both `en`. */
function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Throws unless `model` can translate into `target`. A translating model that reports no target list is English-only.
 * The server transcribes instead when the source language already is the target, so that case is not refused here.
 */
function assertCanTranslate(
  model: string,
  caps: ModelCapabilities | undefined,
  target: string,
  source: string | null | undefined,
): void {
  if (!caps?.translation) {
    throw new UnsupportedCapabilityError(`Model "${model}" does not support translation.`);
  }
  if (source && baseLanguage(source) === baseLanguage(target)) return;
  const offered = caps.translationTargets ?? ["en"];
  if (!offered.includes(target)) {
    throw new UnsupportedCapabilityError(
      `Model "${model}" cannot translate into "${target}" (it offers: ${offered.join(", ")}).`,
    );
  }
}

function mapModelEntry(entry: ServerModelEntry): ModelInfo {
  const capabilities = deriveCapabilities(entry.capabilities);
  // Prefer the top-level `language_detect` field (0.1.1+) over the derived
  // capability, which only reflects a `"supported"` status.
  if (typeof entry.language_detect === "boolean") {
    capabilities.languageDetect = entry.language_detect;
  }
  return {
    id: entry.id,
    // Prefer the server's friendly `name` field; fall back to `id` only when
    // the server has no name for this entry (defensive for older servers).
    name: entry.name?.trim() ? entry.name : entry.id,
    languages: deriveLanguages(entry),
    isDefault: entry.default === true,
    capabilities,
  };
}

const STT_SERVER_CAPABILITY: ProviderCapability = {
  id: "stt-server",
  displayName: "STT Server",
  transport: "http",
  requiresAudioInput: true,
  privacy: "local",
  // Live transcription exists for the models whose `capabilities.streaming` is supported (`ModelInfo`); the
  // provider itself can open the stream for them.
  supportsPartials: true,
  supportsWordTimestamps: true,
  supportsLanguageHint: true,
  supportsStreaming: true,
  supportsBatch: true,
  available: true,
};

/**
 * Adapter for `stt-server`, used exactly like a cloud provider: connect
 * with a base URL and a token, list callable models, transcribe/translate
 * naming a model per request. No model management, discovery, install, or
 * server lifecycle — that stays the app's job via the server's own APIs.
 */
export class SttServerProvider implements SttProvider {
  readonly id = "stt-server";
  readonly capability: ProviderCapability = STT_SERVER_CAPABILITY;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly openSocket: WebSocketFactory;

  private versionChecked = false;
  private modelsCache: Map<string, ModelInfo> | null = null;

  constructor(options: SttServerProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = resolveFetch(options);
    this.openSocket = options.webSocketFactory ?? defaultSocketFactory(resolveWebSocket(options));
  }

  private async ensureVersion(): Promise<void> {
    if (this.versionChecked) return;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`, { method: "GET" });
    } catch (err) {
      throw new ConnectionError("Failed to reach stt-server /health.", { cause: err });
    }
    if (!res.ok) {
      throw new ServerVersionError(
        `stt-server /health returned HTTP ${res.status}.`,
        { code: "not_stt_server" },
      );
    }
    let body: ServerHealth;
    try {
      body = (await res.json()) as ServerHealth;
    } catch (err) {
      throw new ServerVersionError("stt-server /health did not return JSON.", {
        code: "not_stt_server",
      });
    }
    if (body.service !== EXPECTED_SERVICE) {
      throw new ServerVersionError(
        `Expected service "${EXPECTED_SERVICE}", got "${body.service ?? "unknown"}".`,
        { code: "not_stt_server", details: body },
      );
    }
    const apiLevel = body.api_level ?? 0;
    if (apiLevel < MIN_API_LEVEL) {
      throw new ServerVersionError(
        `stt-server api_level ${apiLevel} is older than the minimum required (${MIN_API_LEVEL}).`,
        { code: "server_too_old", details: body },
      );
    }
    this.versionChecked = true;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async parseErrorBody(res: Response): Promise<ServerErrorBody["error"] | undefined> {
    try {
      const body = (await res.json()) as ServerErrorBody;
      return body.error;
    } catch {
      return undefined;
    }
  }

  /** Maps a non-ok HTTP response into the stable SDK error hierarchy. */
  private async toServerError(res: Response): Promise<ServerError> {
    const error = await this.parseErrorBody(res);
    const code = error?.code ?? "api_error";
    const message = error?.message ?? `stt-server returned HTTP ${res.status}.`;
    const details = error?.details;

    switch (code) {
      case "server_not_ready":
        return new ServerNotReadyError(message, { status: res.status, details });
      case "model_loading":
        return new ModelLoadingError(message, { status: res.status, details });
      case "model_not_installed":
        return new ModelNotInstalledError(message, { status: res.status, details });
      case "unsupported_capability":
        return new ServerUnsupportedCapabilityError(message, { status: res.status, details });
      case "engine_busy":
      case "queue_full":
        return new ServerBusyError(message, { code, status: res.status, details });
      case "admin_required":
        return new AdminRequiredError(message, { status: res.status, details });
      case "unauthorized":
        return new UnauthorizedError(message, { status: res.status, details });
      case "network_not_private":
        return new NetworkNotPrivateError(message, { status: res.status, details });
      default:
        // Unknown server code passes through verbatim rather than being
        // swallowed into a generic bucket.
        return new ServerError(message, { code, status: res.status, details, retryable: false });
    }
  }

  /**
   * Fetches and caches callable models with their capabilities. Refreshed on
   * demand (first call, or after a `model_not_installed`/capability error
   * suggests the cache is stale).
   */
  private async fetchModels(): Promise<Map<string, ModelInfo>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: this.authHeaders(),
      });
    } catch (err) {
      throw new ConnectionError("Failed to reach stt-server /v1/models.", { cause: err });
    }
    if (!res.ok) throw await this.toServerError(res);
    const body = (await res.json()) as ServerModelsList;
    const map = new Map<string, ModelInfo>();
    for (const entry of body.data ?? []) {
      map.set(entry.id, mapModelEntry(entry));
    }
    this.modelsCache = map;
    return map;
  }

  private async getModelsCache(refresh = false): Promise<Map<string, ModelInfo>> {
    if (!this.modelsCache || refresh) {
      return this.fetchModels();
    }
    return this.modelsCache;
  }

  private async resolveModelCapabilities(modelId: string | undefined): Promise<ModelCapabilities | undefined> {
    const cache = await this.getModelsCache();
    if (!modelId || modelId === "default") {
      for (const model of cache.values()) {
        if (model.isDefault) return model.capabilities;
      }
      return undefined;
    }
    return cache.get(modelId)?.capabilities;
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.ensureVersion();
    const cache = await this.fetchModels();
    return Array.from(cache.values());
  }

  private buildForm(
    request: BatchTranscriptionRequest,
    caps: ModelCapabilities | undefined,
    targetLanguage: string | undefined,
  ): FormData {
    const form = new FormData();
    form.append("file", toBlob(request.file), request.filename?.trim() || "recording.wav");
    if (request.model?.trim()) form.append("model", request.model.trim());

    if (request.prompt !== undefined && caps?.prompt) {
      // Passed through verbatim — the app builds the prompt (including
      // vocabulary words); the SDK never rewrites or trims it.
      form.append("prompt", request.prompt);
    }
    if (request.language?.trim() && caps?.languageHint) {
      form.append("language", request.language.trim());
    }
    if (request.temperature !== undefined && caps?.temperature) {
      form.append("temperature", String(request.temperature));
    }
    // English is what the translations endpoint does without the field, and an older server rejects the field.
    if (targetLanguage && targetLanguage !== "en") form.append("target_language", targetLanguage);
    if (request.wordTimestamps && caps?.timestamps?.word) {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities", "word");
    } else if (request.wordTimestamps && caps?.timestamps?.segment) {
      // Word timestamps unsupported on this model — fall back to segment
      // granularity so the request is never rejected for an option the
      // model can't honor.
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities", "segment");
    }
    return form;
  }

  /**
   * POSTs the form `build` makes to `path` and returns the parsed JSON body. When the server answers with a code that
   * says the model list was stale, `refresh` runs once and the request is sent again, rebuilt.
   */
  private async postForm(
    path: string,
    build: () => FormData,
    signal: AbortSignal | undefined,
    refresh?: () => Promise<void>,
  ): Promise<unknown> {
    const attempt = async (): Promise<Response> => {
      const form = build();
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.authHeaders(),
          body: form,
          signal,
        });
      } catch (err) {
        throw new ConnectionError(`Failed to reach stt-server ${path}.`, { cause: err });
      }
    };

    let res = await attempt();
    if (!res.ok && refresh) {
      const error = await this.parseErrorBody(res.clone());
      const staleCacheCodes = new Set(["model_not_installed", "unsupported_capability"]);
      if (error?.code && staleCacheCodes.has(error.code)) {
        // Refresh capabilities cache and retry once — the model list may
        // have changed underneath us (newly installed/verified, or the
        // live capability view replaced a stale "unknown").
        await refresh();
        res = await attempt();
      }
    }
    if (!res.ok) throw await this.toServerError(res);
    return res.json();
  }

  /** `translation` is set for the translations endpoint; its `targetLanguage` defaults to English. */
  private async postAudio(
    path: string,
    request: BatchTranscriptionRequest,
    translation?: { targetLanguage: string },
  ): Promise<TranscriptionResult> {
    await this.ensureVersion();
    let caps = await this.resolveModelCapabilities(request.model);

    if (translation) {
      assertCanTranslate(request.model ?? "default", caps, translation.targetLanguage, request.language);
    }

    const body = await this.postForm(
      path,
      () => this.buildForm(request, caps, translation?.targetLanguage),
      request.signal,
      async () => {
        caps = (await this.getModelsCache(true)).get(request.model ?? "")?.capabilities ?? caps;
      },
    );
    return mapTranscriptionResponse(body as ServerTranscriptionResponse);
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    return this.postAudio("/v1/audio/transcriptions", request);
  }

  async translate(request: BatchTranslationRequest): Promise<TranscriptionResult> {
    return this.postAudio("/v1/audio/translations", request, {
      targetLanguage: request.targetLanguage?.trim() || "en",
    });
  }

  /**
   * Finds the speech in a finished recording (`POST /v1/audio/vad`, an stt-server extension): Silero VAD runs in the
   * server, needs no loaded model and never waits behind a transcription. `audio` must be a WAV file, as for
   * {@link transcribe}. Live voice-activity detection stays in the client; this is for audio that already exists.
   * An stt-server older than this endpoint answers 404, which surfaces as a {@link ServerError}.
   */
  async detectSpeech(
    audio: Blob | ArrayBuffer | Uint8Array,
    options: SpeechDetectionOptions = {},
  ): Promise<SpeechDetectionResult> {
    await this.ensureVersion();
    const body = (await this.postForm(
      "/v1/audio/vad",
      () => {
        const form = new FormData();
        form.append("file", toBlob(audio), options.filename?.trim() || "recording.wav");
        const settings = {
          threshold: options.threshold,
          min_speech_ms: options.minSpeechMs,
          min_silence_ms: options.minSilenceMs,
          speech_pad_ms: options.speechPadMs,
        };
        for (const [name, value] of Object.entries(settings)) {
          if (value !== undefined) form.append(name, String(value));
        }
        return form;
      },
      options.signal,
    )) as ServerSpeechDetectionResponse;
    return { segments: body.segments, speechRatio: body.speech_ratio, duration: body.duration };
  }

  /**
   * Live transcription of `config.model` (`default` = the server's default) over `/v1/realtime`. Only models whose
   * `ModelInfo.capabilities.streaming` is true can stream; the audio is 16-bit PCM mono at `config.sampleRate`.
   * Rejects with {@link UnsupportedCapabilityError} otherwise, so the caller falls back to {@link transcribe}.
   * With `config.targetLanguage` the turns are translated instead: that needs `capabilities.translation` (and a target
   * the model offers) but not streaming, because a model that cannot stream translates the whole turn at `stop()`.
   * The server runs one stream at a time and cannot transcribe a batch with the streaming model meanwhile.
   */
  async createStream(config: StreamConfig): Promise<StreamSession> {
    if (config.encoding !== "pcm_s16le" || config.channels !== 1) {
      throw new UnsupportedCapabilityError("stt-server live transcription takes 16-bit mono PCM (pcm_s16le, 1 channel).");
    }
    await this.ensureVersion();
    const model = config.model?.trim() || "default";
    const caps = await this.resolveModelCapabilities(model);
    const targetLanguage = config.targetLanguage?.trim();
    if (targetLanguage) {
      assertCanTranslate(model, caps, targetLanguage, config.language);
    } else if (!caps?.streaming) {
      throw new UnsupportedCapabilityError(`Model "${model}" does not support live transcription.`);
    }
    const url = new URL("/v1/realtime", this.baseUrl.replace(/^http/, "ws"));
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", model);
    const session = new SttServerStreamSession(
      { url: url.toString(), token: this.token, openSocket: this.openSocket, connectTimeoutMs: 5000, stopTimeoutMs: 10000 },
      { ...config, targetLanguage },
    );
    await session.start();
    return session;
  }
}

/** The bearer header goes where the platform lets a socket carry one (Node); a browser connects without it. */
function defaultSocketFactory(WS: typeof WebSocket): WebSocketFactory {
  return (url, headers) => ("document" in globalThis ? new WS(url) : new WS(url, { headers } as never));
}

function mapWord(word: ServerTranscriptionWord): TranscriptWord {
  return {
    word: word.word,
    startMs: Math.round(word.start * 1000),
    endMs: Math.round(word.end * 1000),
    probability: word.probability ?? 0,
  };
}

function mapSegment(segment: ServerTranscriptionSegment): TranscriptionSegment {
  return {
    text: segment.text,
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    avgLogprob: segment.avg_logprob,
    noSpeechProb: segment.no_speech_prob,
    compressionRatio: segment.compression_ratio,
    words: segment.words?.map(mapWord),
  };
}

function mapTranscriptionResponse(body: ServerTranscriptionResponse): TranscriptionResult {
  const result: TranscriptionResult = { text: body.text };
  if (body.language !== undefined) result.language = body.language;
  if (body.duration !== undefined) result.durationMs = Math.round(body.duration * 1000);
  if (body.segments !== undefined) result.segments = body.segments.map(mapSegment);
  if (body.x_diagnostics !== undefined) result.diagnostics = body.x_diagnostics;
  return result;
}
