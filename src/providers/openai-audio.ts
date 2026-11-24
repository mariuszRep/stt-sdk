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
import { fromCloudCatalog } from "../registry/adapters/cloud";
import { languagesOfMatrix, toBooleans } from "../registry/capabilities";
import { BUILTIN_PROVIDERS, KNOWN_CLOUD_MODELS } from "../registry/data";
import type { ProviderDescriptor, ProviderService } from "../registry/types";
import { mapTranscriptionResponse, type ServerTranscriptionResponse } from "./openai-transcription";

export interface OpenAIAudioOptions extends TransportDeps {
  /** The provider's API key, sent as a bearer token. */
  apiKey: string;
  /** API base URL including the version path (`https://api.openai.com/v1`); defaults to the provider's own (the registry's). */
  baseUrl?: string;
}

/** The file extension the API reads the audio format from, by the blob's type (`audio/webm;codecs=opus` is webm); wav when unknown. */
function extensionOf(type: string): string {
  const subtype = type.split(";")[0]!.split("/")[1] ?? "";
  return ({ webm: "webm", ogg: "ogg", mpeg: "mp3", mp3: "mp3", mp4: "mp4", m4a: "m4a", "x-m4a": "m4a", flac: "flac" } as Record<string, string>)[subtype] ?? "wav";
}

/** The built-in provider `id` and its speech service, from the registry's provider data. */
function speechServiceOf(id: string): { provider: ProviderDescriptor; service: ProviderService } {
  const provider = BUILTIN_PROVIDERS.providers.find((candidate) => candidate.id === id);
  const service = provider?.serves.find((candidate) => candidate.kind === "speech");
  if (!provider || !service) throw new Error(`The registry has no speech service for provider "${id}"`);
  return { provider, service };
}

/**
 * Batch transcription over the OpenAI audio API (`POST {base}/audio/transcriptions`, multipart), which OpenAI serves and
 * Groq copies. The endpoint, the provider's name, which refusals are worth retrying and the models listed are the
 * registry's data for the provider (`providers.json`, `cloud-models.json`); the answer is read as stt-server's is
 * (`mapTranscriptionResponse`). Streaming is not offered: OpenAI's live transcription is a different (realtime) API.
 *
 * Word timings are asked for only when the request asks for them (`verbose_json`, word and segment granularity); a model
 * that cannot give them (OpenAI's `gpt-transcribe`) answers with an error, which is thrown as an {@link ApiError}.
 */
export class OpenAIAudioProvider implements SttProvider {
  readonly id: string;
  readonly capability: ProviderCapability;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly retryStatuses: readonly number[];
  /** How long a call may take when the caller gives no signal of its own (the registry's `timeouts.totalMs`). */
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: typeof fetch;

  /** `id`: the provider's id in the registry (`openai`, `groq`); `defaultModel`: the model a request without `model` goes to. */
  protected constructor(id: string, defaultModel: string, options: OpenAIAudioOptions) {
    const { provider, service } = speechServiceOf(id);
    if (!options.apiKey) throw new Error(`${provider.name} requires an apiKey`);
    this.id = id;
    this.capability = {
      id,
      displayName: provider.name,
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
    this.baseUrl = (options.baseUrl ?? service.baseUrl).replace(/\/+$/, "");
    this.defaultModel = defaultModel;
    this.retryStatuses = service.retry?.statuses ?? [];
    this.timeoutMs = service.timeouts?.totalMs;
    this.fetchImpl = resolveFetch(options);
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = KNOWN_CLOUD_MODELS.models.filter((record) => record.provider === this.id && record.kind === "speech");
    return fromCloudCatalog({ ...KNOWN_CLOUD_MODELS, models }, BUILTIN_PROVIDERS.providers).map((entry) => ({
      id: entry.id,
      name: entry.name,
      languages: languagesOfMatrix(entry.capabilities) ?? entry.languages,
      isDefault: entry.id === this.defaultModel,
      capabilities: toBooleans(entry.capabilities),
    }));
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    const name = this.capability.displayName;
    const form = new FormData();
    const file = toBlob(request.file);
    form.append("file", file, request.filename ?? `recording.${extensionOf(file.type)}`);
    form.append("model", request.model ?? this.defaultModel);
    if (request.language) form.append("language", request.language);
    if (request.prompt) form.append("prompt", request.prompt);
    if (request.temperature !== undefined) form.append("temperature", String(request.temperature));
    if (request.wordTimestamps) {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
    } else {
      form.append("response_format", "json");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: request.signal ?? (this.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.timeoutMs)),
      });
    } catch (err) {
      throw new ConnectionError(`${name} transcription request failed`, { cause: err });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(`${name} transcription failed: ${res.status} ${detail}`.trim(), {
        status: res.status,
        code: "transcription_failed",
        retryable: this.retryStatuses.includes(res.status),
      });
    }
    let body: ServerTranscriptionResponse;
    try {
      body = (await res.json()) as ServerTranscriptionResponse;
    } catch (err) {
      throw new ApiError(`${name} answered with something that is not a transcription`, { status: res.status, code: "invalid_response", cause: err });
    }
    return mapTranscriptionResponse(body);
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError(`${this.capability.displayName} transcribes whole recordings only, not a live stream.`);
  }
}
