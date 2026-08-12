import type { SttProvider } from "../provider";
import type {
  BatchTranscriptionRequest,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
} from "../types";
import { UnsupportedCapabilityError } from "../errors";

export interface OpenAIProviderOptions {
  /** OpenAI API key. */
  apiKey: string;
  /** API base URL, default `https://api.openai.com`. */
  baseUrl?: string;
}

/**
 * Named adapter seam for the OpenAI transcription API.
 *
 * Constructing this provider succeeds and reports its capability, but every
 * operation throws {@link UnsupportedCapabilityError} until the adapter is
 * implemented. The SDK does not add first-time provider implementations beyond
 * the selected initial contract proof (see README).
 */
export class OpenAIProvider implements SttProvider {
  readonly id = "openai";
  readonly capability: ProviderCapability = {
    id: "openai",
    displayName: "OpenAI",
    transport: "http",
    requiresAudioInput: true,
    privacy: "cloud",
    supportsPartials: false,
    supportsWordTimestamps: false,
    supportsLanguageHint: true,
    supportsStreaming: false,
    supportsBatch: true,
    available: false,
    unavailableReason:
      "Not implemented — named adapter seam; no first-time provider implementation beyond the selected cloud proof.",
  };

  constructor(readonly options: OpenAIProviderOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    throw new UnsupportedCapabilityError("OpenAIProvider.listModels is not implemented yet.");
  }

  async transcribe(_request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    throw new UnsupportedCapabilityError("OpenAIProvider.transcribe is not implemented yet.");
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError("OpenAIProvider.createStream is not implemented yet.");
  }
}
