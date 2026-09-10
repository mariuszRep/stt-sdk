import type { SttProvider } from "../provider";
import type { TransportDeps } from "../transport";
import { resolveFetch, toBlob } from "../transport";
import type {
  BatchTranscriptionRequest,
  DescriptorAuth,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptWord,
} from "../types";
import { ApiError, ConnectionError, UnsupportedCapabilityError } from "../errors";

export interface LocalRuntimeOptions extends TransportDeps {
  /** Base URL of the local runtime, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  /**
   * Informational only (see `createProvider`'s protocol-driven dispatch) —
   * surfaced as `id`/`capability.id`, never used to pick a different code
   * path. Any conformant runtime is driven identically regardless of this
   * value.
   */
  id: string;
  capability: ProviderCapability;
  /**
   * From the runtime connection descriptor's own `auth` field. When
   * `type === "token"`, every request carries `Authorization: Bearer
   * <value>`. Strictly descriptor-driven — this class never invents,
   * stores, or negotiates credentials on its own.
   */
  auth?: DescriptorAuth;
}

interface ConfigResponse {
  schema_version?: number;
  model: string;
}

interface TranscriptionWordResponse {
  word: string;
  start: number;
  end: number;
  probability: number;
}

interface TranscriptionSegmentResponse {
  text: string;
  start: number;
  end: number;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
  words?: TranscriptionWordResponse[];
}

interface TranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: TranscriptionSegmentResponse[];
}

function toTranscriptWord(word: TranscriptionWordResponse): TranscriptWord {
  return {
    word: word.word,
    startMs: Math.round(word.start * 1000),
    endMs: Math.round(word.end * 1000),
    probability: word.probability,
  };
}

function toTranscriptionSegment(segment: TranscriptionSegmentResponse): TranscriptionSegment {
  return {
    text: segment.text,
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    avgLogprob: segment.avg_logprob,
    noSpeechProb: segment.no_speech_prob,
    compressionRatio: segment.compression_ratio,
    words: segment.words?.map(toTranscriptWord),
  };
}

// The runtime response is additive over the historical `{ text }` contract — only
// include `language`/`duration`/`segments` when the runtime actually sent them, so a
// plain-text response still normalizes to a plain `{ text }` result.
function toTranscriptionResult(body: TranscriptionResponse): TranscriptionResult {
  const result: TranscriptionResult = { text: body.text ?? "" };
  if (body.language !== undefined) result.language = body.language;
  if (body.duration !== undefined) result.durationMs = Math.round(body.duration * 1000);
  if (body.segments !== undefined) result.segments = body.segments.map(toTranscriptionSegment);
  return result;
}

/**
 * Generic Local Provider Protocol (`voice-typer-v1`) runtime adapter.
 *
 * This is what `createProvider` constructs for *any* descriptor whose
 * `protocol` is `"voice-typer-v1"`, regardless of `descriptor.provider` —
 * see `factory.ts`. A conformant runtime works because it speaks the
 * protocol, not because its name is hardcoded here. `FasterWhisperProvider`
 * is a thin subclass fixing `id`/`capability` to their historical values for
 * source compatibility; its actual wire behavior is this class's.
 *
 * Wire contract: batch multipart `POST /v1/audio/transcriptions` with
 * `file` (+ optional `prompt`, no `model` — a managed runtime serves the
 * single model it was launched with), response `{ text, language?,
 * duration?, segments? }`. `GET /v1/config` for `listModels()`. Every
 * request carries `Authorization: Bearer <token>` when the descriptor
 * supplied one.
 *
 * Batch-only: local streaming was removed (see `FasterWhisperProvider`'s
 * own doc comment / the 2026-09-05 decision) and no local runtime
 * advertises it today: `createStream()` throws
 * {@link UnsupportedCapabilityError}.
 */
export class LocalRuntimeProvider implements SttProvider {
  readonly id: string;
  readonly capability: ProviderCapability;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string | undefined;

  constructor(options: LocalRuntimeOptions) {
    this.id = options.id;
    this.capability = options.capability;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = resolveFetch(options);
    this.authHeader =
      options.auth?.type === "token" ? `Bearer ${options.auth.value}` : undefined;
  }

  private authHeaders(): Record<string, string> | undefined {
    return this.authHeader ? { Authorization: this.authHeader } : undefined;
  }

  async listModels(): Promise<ModelInfo[]> {
    // The current runtime exposes the active model through /v1/config; there is
    // no models catalog endpoint yet. The configured model is the only model.
    const config = (await this.getConfig()) as ConfigResponse;
    return [{ id: config.model, name: config.model }];
  }

  private async getConfig(): Promise<ConfigResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/config`, {
        headers: this.authHeaders(),
      });
    } catch (err) {
      throw new ConnectionError("Config fetch failed", { cause: err });
    }
    if (!res.ok) {
      throw new ApiError(`Config fetch failed: ${res.status}`, { status: res.status });
    }
    return (await res.json()) as ConfigResponse;
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    // Wire contract preserved from the App: multipart `file` (+ optional
    // `prompt`), POST /v1/audio/transcriptions, response `{ text }`. No
    // `model` field — a managed runtime serves the model it was launched with.
    const form = new FormData();
    form.append("file", toBlob(request.file), request.filename ?? "recording.webm");
    if (request.prompt && request.prompt.trim()) {
      form.append("prompt", request.prompt.trim());
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: request.signal,
        headers: this.authHeaders(),
      });
    } catch (err) {
      throw new ConnectionError("Transcription request failed", { cause: err });
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new ApiError(`Transcription failed: ${res.status} ${errorText}`, {
        status: res.status,
        code: "transcription_failed",
      });
    }

    const body = (await res.json()) as TranscriptionResponse;
    return toTranscriptionResult(body);
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError(
      `${this.id}.createStream is not supported; no local runtime protocol (voice-typer-v1) advertises streaming today. Use transcribe() (batch) instead.`,
    );
  }
}
