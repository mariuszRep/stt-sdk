import type { SttProvider } from "../provider";
import type { TransportDeps } from "../transport";
import { resolveFetch, toBlob } from "../transport";
import type {
  BatchTranscriptionRequest,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptWord,
} from "../types";
import { ApiError, ConnectionError, UnsupportedCapabilityError } from "../errors";

export interface FasterWhisperOptions extends TransportDeps {
  /** Base URL of the local runtime, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
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
 * Local Faster Whisper runtime adapter.
 *
 * Preserves the App's current wire behavior exactly: batch multipart
 * `POST /v1/audio/transcriptions` with `file` + optional `prompt`, response
 * `{ text }` (additively including `language`/`duration`/`segments` when the
 * runtime sends them).
 *
 * This adapter is batch-only. It previously also implemented a `WS
 * /v1/audio/stream` protocol v1 streaming session, but that local streaming
 * engine was removed from the runtime — its transcription quality never
 * justified the complexity, and it was never the source of committed/pasted
 * text (that always came from this same batch endpoint). `createStream()`
 * throws {@link UnsupportedCapabilityError}, matching how `OpenAIProvider`,
 * `GroqProvider`, and `WhisperCppProvider` already signal an unsupported
 * capability.
 */
export class FasterWhisperProvider implements SttProvider {
  readonly id = "faster-whisper";
  readonly capability: ProviderCapability = {
    id: "faster-whisper",
    displayName: "Faster Whisper (local)",
    transport: "http",
    requiresAudioInput: true,
    privacy: "local",
    supportsPartials: true,
    supportsWordTimestamps: false,
    supportsLanguageHint: true,
    supportsStreaming: false,
    supportsBatch: true,
    available: true,
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FasterWhisperOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = resolveFetch(options);
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
      res = await this.fetchImpl(`${this.baseUrl}/v1/config`);
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
    // `prompt`), POST /v1/audio/transcriptions, response `{ text }`.
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
      "FasterWhisperProvider.createStream is no longer supported; the local WS streaming engine was removed. Use transcribe() (batch) instead.",
    );
  }
}
