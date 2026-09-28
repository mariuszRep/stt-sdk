import type { SttProvider } from "../provider";
import type {
  BatchTranscriptionRequest,
  BatchTranslationRequest,
  ModelCapabilities,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptWord,
} from "../types";
import type { TransportDeps } from "../transport";
import { resolveFetch, toBlob } from "../transport";
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

export interface SttServerNextProviderOptions extends TransportDeps {
  /** Base URL of the stt-server-next instance, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  /** Bearer token (admin or user token — see the server's client contract, section 3). */
  token: string;
}

/** Minimum `api_level` (see `/health`) this adapter requires. */
const MIN_API_LEVEL = 1;
const EXPECTED_SERVICE = "stt-server-next";

interface ControlCapability {
  status?: "supported" | "unsupported" | "unknown" | string;
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
  object?: string;
  owned_by?: string;
  default?: boolean;
  capabilities?: Record<string, ControlCapability> & { language_hint?: LanguageHintCapability };
  /** Top-level convenience fields added in stt-server-next 0.1.1. */
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

/**
 * Derives the SDK's simple supported/not-supported {@link ModelCapabilities}
 * booleans from stt-server-next's richer per-control status values
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
  return {
    prompt: supported(raw?.prompt),
    languageHint: supported(raw?.language_hint),
    languageDetect: supported(raw?.language_detect),
    translation: supported(raw?.translation),
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
 * The model's supported language codes: prefers the top-level `languages`
 * field (stt-server-next 0.1.1+), falling back to `capabilities.language_hint`'s
 * live `languages` or catalog `model_claim` (see {@link LanguageHintCapability}).
 */
function deriveLanguages(entry: ServerModelEntry): string[] | undefined {
  if (Array.isArray(entry.languages)) return entry.languages;
  const hint = entry.capabilities?.language_hint;
  return hint?.languages ?? hint?.extra?.languages ?? hint?.model_claim ?? hint?.extra?.model_claim;
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
    name: entry.id,
    languages: deriveLanguages(entry),
    isDefault: entry.default === true,
    capabilities,
  };
}

const SERVER_NEXT_CAPABILITY: ProviderCapability = {
  id: "stt-server-next",
  displayName: "STT Server Next",
  transport: "http",
  requiresAudioInput: true,
  privacy: "local",
  supportsPartials: false,
  supportsWordTimestamps: true,
  supportsLanguageHint: true,
  supportsStreaming: false,
  supportsBatch: true,
  available: true,
};

/**
 * Adapter for `stt-server-next`, used exactly like a cloud provider: connect
 * with a base URL and a token, list callable models, transcribe/translate
 * naming a model per request. No model management, discovery, install, or
 * server lifecycle — that stays the app's job via the server's own APIs.
 */
export class SttServerNextProvider implements SttProvider {
  readonly id = "stt-server-next";
  readonly capability: ProviderCapability = SERVER_NEXT_CAPABILITY;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  private versionChecked = false;
  private modelsCache: Map<string, ModelInfo> | null = null;

  constructor(options: SttServerNextProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = resolveFetch(options);
  }

  private async ensureVersion(): Promise<void> {
    if (this.versionChecked) return;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`, { method: "GET" });
    } catch (err) {
      throw new ConnectionError("Failed to reach stt-server-next /health.", { cause: err });
    }
    if (!res.ok) {
      throw new ServerVersionError(
        `stt-server-next /health returned HTTP ${res.status}.`,
        { code: "not_stt_server_next" },
      );
    }
    let body: ServerHealth;
    try {
      body = (await res.json()) as ServerHealth;
    } catch (err) {
      throw new ServerVersionError("stt-server-next /health did not return JSON.", {
        code: "not_stt_server_next",
      });
    }
    if (body.service !== EXPECTED_SERVICE) {
      throw new ServerVersionError(
        `Expected service "${EXPECTED_SERVICE}", got "${body.service ?? "unknown"}".`,
        { code: "not_stt_server_next", details: body },
      );
    }
    const apiLevel = body.api_level ?? 0;
    if (apiLevel < MIN_API_LEVEL) {
      throw new ServerVersionError(
        `stt-server-next api_level ${apiLevel} is older than the minimum required (${MIN_API_LEVEL}).`,
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
    const message = error?.message ?? `stt-server-next returned HTTP ${res.status}.`;
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
      throw new ConnectionError("Failed to reach stt-server-next /v1/models.", { cause: err });
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

  private async postAudio(
    path: string,
    request: BatchTranscriptionRequest,
    requireTranslation: boolean,
  ): Promise<TranscriptionResult> {
    await this.ensureVersion();
    let caps = await this.resolveModelCapabilities(request.model);

    if (requireTranslation && !caps?.translation) {
      throw new UnsupportedCapabilityError(
        `Model "${request.model ?? "default"}" does not support translation.`,
      );
    }

    const attempt = async (): Promise<Response> => {
      const form = this.buildForm(request, caps);
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.authHeaders(),
          body: form,
          signal: request.signal,
        });
      } catch (err) {
        throw new ConnectionError(`Failed to reach stt-server-next ${path}.`, { cause: err });
      }
    };

    let res = await attempt();
    if (!res.ok) {
      const error = await this.parseErrorBody(res.clone());
      const staleCacheCodes = new Set(["model_not_installed", "unsupported_capability"]);
      if (error?.code && staleCacheCodes.has(error.code)) {
        // Refresh capabilities cache and retry once — the model list may
        // have changed underneath us (newly installed/verified, or the
        // live capability view replaced a stale "unknown").
        caps = (await this.getModelsCache(true)).get(request.model ?? "")?.capabilities ?? caps;
        res = await attempt();
      }
    }
    if (!res.ok) throw await this.toServerError(res);

    const body = (await res.json()) as ServerTranscriptionResponse;
    return mapTranscriptionResponse(body);
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    return this.postAudio("/v1/audio/transcriptions", request, false);
  }

  async translate(request: BatchTranslationRequest): Promise<TranscriptionResult> {
    return this.postAudio("/v1/audio/translations", request, true);
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError(
      "SttServerNextProvider does not support streaming (out of scope for this adapter).",
    );
  }
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
