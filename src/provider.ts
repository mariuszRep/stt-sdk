import type {
  BatchTranscriptionRequest,
  BatchTranslationRequest,
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
  /**
   * Translate speech in another language to English, where the provider and
   * chosen model support it. Optional so providers without translation
   * support are unaffected.
   */
  translate?(request: BatchTranslationRequest): Promise<TranscriptionResult>;
}
