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
} from "../types";
import { ApiError, ConnectionError, UnsupportedCapabilityError } from "../errors";
import { languagesOfMatrix, toBooleans } from "../registry/capabilities";
import { listCloudEntries } from "../registry/data";

export interface OpenAIAudioOptions extends TransportDeps {
  /** The provider's API key, sent as a bearer token. */
  apiKey: string;
  /** API base URL including the version path (`https://api.openai.com/v1`); defaults to the provider's own. */
  baseUrl?: string;
}

/** What tells one OpenAI-style audio provider from another. */
interface OpenAIAudioService {
  /** The provider id the registry knows it by (`openai`, `groq`). */
  id: string;
  displayName: string;
  defaultBaseUrl: string;
  /** The model a request without `model` is sent to. */
  defaultModel: string;
}

interface VerboseWord {
  word: string;
  start: number;
  end: number;
}

/** `response_format=json` gives `text` alone; `verbose_json` adds the language, the duration and the word timings. */
interface TranscriptionBody {
  text?: string;
  language?: string;
  duration?: number;
  words?: VerboseWord[];
}

const ms = (seconds: number) => Math.round(seconds * 1000);

/**
 * Batch transcription over the OpenAI audio API (`POST {base}/audio/transcriptions`, multipart), which OpenAI serves and
 * Groq copies. Streaming is not offered: OpenAI's live transcription is a different (realtime) API. The models listed are
 * the SDK's known models of the provider (the registry's data), since the providers' own model lists do not say which
 * models transcribe.
 *
 * Word timings are asked for only when the request asks for them (`verbose_json`, word granularity); each word is then a
 * segment, as `DeepgramProvider` gives them. A model that cannot give them (OpenAI's `gpt-transcribe`) answers with
 * an error, which is thrown as an {@link ApiError}.
 */
export class OpenAIAudioProvider implements SttProvider {
  readonly id: string;
  readonly capability: ProviderCapability;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  protected constructor(service: OpenAIAudioService, options: OpenAIAudioOptions) {
    if (!options.apiKey) throw new Error(`${service.displayName} requires an apiKey`);
    this.id = service.id;
    this.capability = {
      id: service.id,
      displayName: service.displayName,
      transport: "http",
      requiresAudioInput: true,
      privacy: "cloud",
      supportsPartials: false,
      supportsWordTimestamps: true,
      supportsLanguageHint: true,
      supportsStreaming: false,
      supportsBatch: true,
      available: true,
    };
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? service.defaultBaseUrl).replace(/\/+$/, "");
    this.defaultModel = service.defaultModel;
    this.fetchImpl = resolveFetch(options);
  }

  async listModels(): Promise<ModelInfo[]> {
    return listCloudEntries()
      .filter((entry) => entry.provider === this.id && entry.kind === "speech")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        languages: languagesOfMatrix(entry.capabilities) ?? entry.languages,
        isDefault: entry.id === this.defaultModel,
        capabilities: toBooleans(entry.capabilities),
      }));
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", toBlob(request.file), request.filename ?? "recording.wav");
    form.append("model", request.model ?? this.defaultModel);
    if (request.language) form.append("language", request.language);
    if (request.prompt) form.append("prompt", request.prompt);
    if (request.temperature !== undefined) form.append("temperature", String(request.temperature));
    if (request.wordTimestamps) {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
    } else {
      form.append("response_format", "json");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: request.signal,
      });
    } catch (err) {
      throw new ConnectionError(`${this.capability.displayName} transcription request failed`, { cause: err });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(`${this.capability.displayName} transcription failed: ${res.status} ${detail}`.trim(), {
        status: res.status,
        code: "transcription_failed",
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    const body = (await res.json()) as TranscriptionBody;
    const words = body.words ?? [];
    return {
      text: body.text ?? "",
      ...(body.language ? { language: body.language } : {}),
      ...(body.duration !== undefined ? { durationMs: ms(body.duration) } : {}),
      ...(words.length ? { segments: words.map((word) => ({ text: word.word, startMs: ms(word.start), endMs: ms(word.end) })) } : {}),
    };
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError(`${this.capability.displayName} transcribes whole recordings only, not a live stream.`);
  }
}
