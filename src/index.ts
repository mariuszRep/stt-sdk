/**
 * @voice-typer/stt-sdk
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
  BatchTranscriptionRequest,
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
} from "./errors";
export type { SttErrorOptions } from "./errors";

export type { SttProvider } from "./provider";
export { createProvider } from "./factory";

export {
  FasterWhisperProvider,
  DeepgramProvider,
  WhisperCppProvider,
  OpenAIProvider,
  GroqProvider,
} from "./providers";
export type {
  FasterWhisperOptions,
  DeepgramOptions,
  WhisperCppOptions,
  OpenAIProviderOptions,
  GroqProviderOptions,
} from "./providers";
