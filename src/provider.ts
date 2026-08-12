import type {
  BatchTranscriptionRequest,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  TranscriptionResult,
} from "./types";

/**
 * The single provider-facing interface shared by local runtime adapters and
 * cloud API translators. Consumers never branch on provider internals.
 */
export interface SttProvider {
  readonly id: string;
  readonly capability: ProviderCapability;
  listModels(): Promise<ModelInfo[]>;
  transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult>;
  createStream(config: StreamConfig): Promise<StreamSession>;
}
