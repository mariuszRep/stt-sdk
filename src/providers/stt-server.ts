import type { SttProvider } from "../provider";
import type {
  BatchTranscriptionRequest,
  BatchTranslationRequest,
  DiarizationOptions,
  DiarizationResult,
  KnownSpeakerEmbedding,
  KnownSpeakerReference,
  ModelCapabilities,
  ModelInfo,
  ProviderCapability,
  SpeakerEmbeddingOptions,
  SpeakerEmbeddingResult,
  SpeechDetectionOptions,
  SpeechDetectionResult,
  StreamConfig,
  StreamSession,
  SubtitleFormat,
  SubtitleRequest,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptWord,
} from "../types";
import type { CapabilityMatrix } from "../registry/capabilities";
import { languagesOfMatrix, toBooleans } from "../registry/capabilities";
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

interface ServerModelEntry {
  id: string;
  /** Friendly display name (catalog name, custom_name, or derived); added in a later server version. */
  name?: string;
  object?: string;
  owned_by?: string;
  default?: boolean;
  capabilities?: CapabilityMatrix;
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

interface ServerSpeakerEmbeddingResponse {
  model: string;
  dim: number;
  duration: number;
  segments: Array<{ start: number; end: number; embedding: string | number[] | null }>;
}

interface ServerSpeechDetectionResponse {
  duration: number;
  speech_seconds: number;
  speech_ratio: number;
  segments: Array<{ start: number; end: number }>;
}

/** Decodes base64 of little-endian f32 bytes (the server's `encoding_format: "base64"`). */
function decodeFloat32(encoded: string): number[] {
  const binary = atob(encoded);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  return Array.from({ length: binary.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

/** Base64 of bytes, in chunks so a long clip does not overflow the argument limit. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 of the little-endian f32 bytes of an embedding (`known_speaker_embeddings[]`). */
function encodeFloat32(values: ArrayLike<number>): string {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true);
  return encodeBase64(new Uint8Array(view.buffer));
}

function isReference(speaker: object): speaker is KnownSpeakerReference {
  return "audio" in speaker;
}

/**
 * The model's supported language codes: prefers the top-level `languages`
 * field (stt-server 0.1.1+), falling back to `capabilities.language_hint`'s
 * live `languages` or catalog `model_claim` (see `languagesOfMatrix`).
 */
function deriveLanguages(entry: ServerModelEntry): string[] | undefined {
  if (Array.isArray(entry.languages)) return entry.languages;
  return languagesOfMatrix(entry.capabilities);
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
  const capabilities = toBooleans(entry.capabilities);
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
    subtitleFormat: SubtitleFormat | undefined,
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
    if (subtitleFormat) {
      // The server renders the segment timestamps itself and refuses a model that has none, so there is no
      // capability to check (or fall back from) here.
      form.append("response_format", subtitleFormat);
    } else if (request.wordTimestamps && caps?.timestamps?.word) {
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
   * POSTs the form `build` makes to `path` and returns the successful response. When the server answers with a code
   * that says the model list was stale, `refresh` runs once and the request is sent again, rebuilt.
   */
  private async postFormResponse(
    path: string,
    build: () => FormData,
    signal: AbortSignal | undefined,
    refresh?: () => Promise<void>,
  ): Promise<Response> {
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
    return res;
  }

  /** {@link postFormResponse} for an endpoint that answers with JSON. */
  private async postForm(
    path: string,
    build: () => FormData,
    signal: AbortSignal | undefined,
    refresh?: () => Promise<void>,
  ): Promise<unknown> {
    return (await this.postFormResponse(path, build, signal, refresh)).json();
  }

  /**
   * `translation` is set for the translations endpoint; its `targetLanguage` defaults to English. With
   * `subtitleFormat` the answer is the subtitle file's text.
   */
  private async postAudio(
    path: string,
    request: BatchTranscriptionRequest,
    translation?: { targetLanguage: string },
    subtitleFormat?: SubtitleFormat,
  ): Promise<Response> {
    await this.ensureVersion();
    let caps = await this.resolveModelCapabilities(request.model);

    if (translation) {
      assertCanTranslate(request.model ?? "default", caps, translation.targetLanguage, request.language);
    }

    return this.postFormResponse(
      path,
      () => this.buildForm(request, caps, translation?.targetLanguage, subtitleFormat),
      request.signal,
      async () => {
        caps = (await this.getModelsCache(true)).get(request.model ?? "")?.capabilities ?? caps;
      },
    );
  }

  /** Posts to the transcriptions or translations endpoint and reads the answer as a result, or as subtitles. */
  private async requestAudio(
    path: string,
    request: BatchTranscriptionRequest & Partial<SubtitleRequest>,
    translation?: { targetLanguage: string },
  ): Promise<TranscriptionResult | string> {
    const subtitleFormat = request.responseFormat;
    const res = await this.postAudio(path, request, translation, subtitleFormat);
    return subtitleFormat
      ? res.text()
      : mapTranscriptionResponse((await res.json()) as ServerTranscriptionResponse);
  }

  /**
   * Transcribes `request.file`. With `responseFormat: "srt"` or `"vtt"` the answer is that subtitle file's text
   * (cues from the segment timestamps, as OpenAI's endpoint returns them); a model without segment timestamps is
   * refused with {@link UnsupportedCapabilityError}.
   */
  async transcribe(request: BatchTranscriptionRequest & SubtitleRequest): Promise<string>;
  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult>;
  async transcribe(request: BatchTranscriptionRequest & Partial<SubtitleRequest>): Promise<TranscriptionResult | string> {
    return this.requestAudio("/v1/audio/transcriptions", request);
  }

  /** Translates `request.file`; `responseFormat` works as for {@link transcribe}. */
  async translate(request: BatchTranslationRequest & SubtitleRequest): Promise<string>;
  async translate(request: BatchTranslationRequest): Promise<TranscriptionResult>;
  async translate(request: BatchTranslationRequest & Partial<SubtitleRequest>): Promise<TranscriptionResult | string> {
    return this.requestAudio("/v1/audio/translations", request, {
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
   * Voice fingerprints of a finished recording (`POST /v1/audio/embeddings`, an stt-server extension): one embedding per
   * segment of `options.segments`, or per speech segment the server's own detection finds. The embeddings are unit
   * vectors of one model (see {@link SpeakerEmbeddingResult.model}); compare them with `cosineSimilarity`, `matchSpeaker`
   * and `clusterSpeakers`. `audio` must be a WAV file, as for {@link transcribe}. Needs no loaded model and never waits
   * behind a transcription. An stt-server older than this endpoint answers 404, which surfaces as a {@link ServerError}.
   */
  async embedSpeakers(
    audio: Blob | ArrayBuffer | Uint8Array,
    options: SpeakerEmbeddingOptions = {},
  ): Promise<SpeakerEmbeddingResult> {
    await this.ensureVersion();
    const body = (await this.postForm(
      "/v1/audio/embeddings",
      () => {
        const form = new FormData();
        form.append("file", toBlob(audio), options.filename?.trim() || "recording.wav");
        if (options.segments) {
          form.append("segments", JSON.stringify(options.segments.map(({ start, end }) => ({ start, end }))));
        }
        // Base64 of the f32 bytes is a third of the size of the JSON numbers.
        form.append("encoding_format", "base64");
        return form;
      },
      options.signal,
    )) as ServerSpeakerEmbeddingResponse;
    return {
      model: body.model,
      dim: body.dim,
      duration: body.duration,
      segments: body.segments.map(({ start, end, embedding }) => ({
        start,
        end,
        embedding: typeof embedding === "string" ? decodeFloat32(embedding) : embedding,
      })),
    };
  }

  /**
   * Who spoke when in a finished recording (`POST /v1/audio/diarize`, an stt-server extension): the speech segments
   * (`options.segments`, or the server's own detection) are fingerprinted, clustered by voice and labelled "A", "B", ...
   * or with the names of `options.knownSpeakers`. The answer has the shape of OpenAI's `diarized_json` segments but no
   * text: transcribe separately and join by time. `audio` must be a WAV file. Needs no loaded model, runs on the CPU
   * and never waits behind a transcription. An stt-server older than this endpoint answers 404, which surfaces as a
   * {@link ServerError}. The server does the clustering; `clusterSpeakers` is the same algorithm for embeddings you hold.
   */
  async diarize(audio: Blob | ArrayBuffer | Uint8Array, options: DiarizationOptions = {}): Promise<DiarizationResult> {
    await this.ensureVersion();
    const known: Array<KnownSpeakerEmbedding | KnownSpeakerReference> = options.knownSpeakers ?? [];
    const references = known.filter(isReference);
    if (references.length > 0 && references.length < known.length) {
      throw new TypeError("knownSpeakers takes embeddings or reference clips, not both.");
    }
    // A clip travels as a data URL, which is how OpenAI takes `known_speaker_references[]`.
    const clips = await Promise.all(
      references.map(async ({ audio: clip }) => {
        const bytes = new Uint8Array(await toBlob(clip).arrayBuffer());
        return `data:audio/wav;base64,${encodeBase64(bytes)}`;
      }),
    );
    return (await this.postForm(
      "/v1/audio/diarize",
      () => {
        const form = new FormData();
        form.append("file", toBlob(audio), options.filename?.trim() || "recording.wav");
        if (options.segments) {
          form.append("segments", JSON.stringify(options.segments.map(({ start, end }) => ({ start, end }))));
        }
        if (options.threshold !== undefined) form.append("threshold", String(options.threshold));
        if (options.maxSpeakers !== undefined) form.append("max_speakers", String(options.maxSpeakers));
        for (const { name } of known) form.append("known_speaker_names[]", name);
        for (const clip of clips) form.append("known_speaker_references[]", clip);
        for (const speaker of known) {
          if (!isReference(speaker)) form.append("known_speaker_embeddings[]", encodeFloat32(speaker.embedding));
        }
        return form;
      },
      options.signal,
    )) as DiarizationResult;
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
