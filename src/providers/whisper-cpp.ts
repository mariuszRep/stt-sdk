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

export interface WhisperCppOptions {
  /** Base URL of the local runtime, e.g. `http://127.0.0.1:8001`. */
  baseUrl: string;
  /** WebSocket streaming endpoint, default `/v1/audio/stream`. */
  streamingEndpoint?: string;
}

/**
 * Named adapter seam for a future Whisper.cpp runtime.
 *
 * Constructing this provider succeeds and reports its capability, but every
 * operation throws {@link UnsupportedCapabilityError} until the adapter is
 * implemented. The SDK does not add first-time provider implementations beyond
 * the selected initial contract proof (see README).
 */
export class WhisperCppProvider implements SttProvider {
  readonly id = "whisper-cpp";
  readonly capability: ProviderCapability = {
    id: "whisper-cpp",
    displayName: "Whisper.cpp (local)",
    transport: "http",
    requiresAudioInput: true,
    privacy: "local",
    supportsPartials: false,
    supportsWordTimestamps: false,
    supportsLanguageHint: false,
    supportsStreaming: false,
    supportsBatch: false,
    available: false,
    unavailableReason:
      "Not implemented — named adapter seam; no first-time provider implementation beyond the selected cloud proof.",
  };

  constructor(readonly options: WhisperCppOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    throw new UnsupportedCapabilityError("WhisperCppProvider.listModels is not implemented yet.");
  }

  async transcribe(_request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    throw new UnsupportedCapabilityError("WhisperCppProvider.transcribe is not implemented yet.");
  }

  async createStream(_config: StreamConfig): Promise<StreamSession> {
    throw new UnsupportedCapabilityError("WhisperCppProvider.createStream is not implemented yet.");
  }
}
