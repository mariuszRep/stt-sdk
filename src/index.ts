/**
 * @open-vibe-ai/stt-sdk
 *
 * Voice Typer provider-communication library: one normalized interface for
 * local runtime endpoints and cloud STT APIs.
 *
 * The public entry point is isomorphic (browser + Node >= 18.18): it uses only
 * standard platform APIs (`fetch`, `WebSocket`, `FormData`, `Blob`).
 */

export { PROTOCOL_VERSION, RUNTIME_DESCRIPTOR_SCHEMA_VERSION } from "./types";
export type {
  TranscriptWord,
  ReadyEvent,
  PartialEvent,
  FinalEvent,
  LaggingEvent,
  ErrorEvent,
  ClosedEvent,
  TranscriptEvent,
  StreamConfig,
  ProviderCapability,
  StreamingCapability,
  DescriptorAuth,
  RuntimeConnectionDescriptor,
  ModelInfo,
  ModelCapabilities,
  BatchTranscriptionRequest,
  BatchTranslationRequest,
  SubtitleFormat,
  SubtitleRequest,
  SpeechDetectionOptions,
  SpeechDetectionResult,
  SpeechSegment,
  DiarizationOptions,
  DiarizationResult,
  DiarizedSegment,
  KnownSpeakerEmbedding,
  KnownSpeakerReference,
  SpeakerEmbeddingOptions,
  SpeakerEmbeddingResult,
  SpeakerSegment,
  TranscriptionSegment,
  TranscriptionResult,
  SessionState,
  StreamSession,
} from "./types";

export {
  SttError,
  UnsupportedCapabilityError,
  ConnectionError,
  ProtocolError,
  ApiError,
  ServerError,
  ServerNotReadyError,
  ModelLoadingError,
  ModelNotInstalledError,
  ServerUnsupportedCapabilityError,
  ServerBusyError,
  AdminRequiredError,
  UnauthorizedError,
  NetworkNotPrivateError,
  ServerVersionError,
} from "./errors";
export type { SttErrorOptions } from "./errors";

export { cosineSimilarity, matchSpeaker, clusterSpeakers } from "./speakers";
export type { SpeakerProfile, SpeakerMatch, ClusterOptions } from "./speakers";

export type { SttProvider } from "./provider";
export { createProvider } from "./factory";

export {
  LocalRuntimeProvider,
  FasterWhisperProvider,
  DeepgramProvider,
  WhisperCppProvider,
  OpenAIProvider,
  GroqProvider,
  SttServerProvider,
  SttServerManagement,
  ModelManagerError,
  CancelledError,
  isModelBusyError,
  managementToken,
  MODEL_BUSY_WAIT_MS,
} from "./providers";
export type {
  LocalRuntimeOptions,
  FasterWhisperOptions,
  DeepgramOptions,
  WhisperCppOptions,
  OpenAIProviderOptions,
  GroqProviderOptions,
  SttServerProviderOptions,
  SttServerManagementOptions,
  TokenBearingConnection,
  OperationState,
  OperationStarted,
  DefaultModelResponse,
  SetDefaultResponse,
  RemoveModelResponse,
  ModelRecommendation,
  SystemInfo,
  LocalConfig,
  HealthResponse,
  ReadinessResponse,
} from "./providers";
export { getModelDisplaySizeBytes } from "./registry/sources";
export type { ManagedModel } from "./registry/sources";
