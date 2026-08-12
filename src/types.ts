/**
 * Normalized provider contract types for the STT SDK.
 *
 * These types are the sole public provider contract for the Voice Typer product.
 * They were migrated and reconciled from the historical App shared types
 * (`@voice-typer/shared`) and the legacy embedded `stt-server/sdk` so local and
 * cloud adapters expose one common interface.
 */

/** Version of the local runtime streaming protocol spoken by this SDK. */
export const PROTOCOL_VERSION = 1 as const;

/** Schema version of {@link RuntimeConnectionDescriptor}. */
export const RUNTIME_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

// ── Timestamps ───────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
  probability: number;
}

// ── Protocol v1 transcript events ────────────────────────────────────────

export interface ReadyEvent {
  type: "ready";
  sessionId: string;
  provider: string;
  protocolVersion: number;
  model: string;
  language: string;
  sampleRate: number;
  channels: number;
}

export interface PartialEvent {
  type: "partial";
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface FinalEvent {
  type: "final";
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  words?: TranscriptWord[];
}

export interface LaggingEvent {
  type: "lagging";
  active: boolean;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export interface ClosedEvent {
  type: "closed";
  reason: "client_stop" | "client_abort" | "error" | "server_shutdown" | (string & {});
}

export type TranscriptEvent =
  | ReadyEvent
  | PartialEvent
  | FinalEvent
  | LaggingEvent
  | ErrorEvent
  | ClosedEvent;

// ── Stream config (sent in the protocol v1 `start` message) ─────────────

export interface StreamConfig {
  language: string | null;
  model: string;
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: number;
  prompt?: string;
  auth?: string;
}

// ── Capability descriptor ────────────────────────────────────────────────

export interface ProviderCapability {
  id: string;
  displayName: string;
  transport: "http" | "websocket" | "browser-native" | (string & {});
  requiresAudioInput: boolean;
  privacy: "local" | "cloud";
  supportsPartials: boolean;
  supportsWordTimestamps: boolean;
  supportsLanguageHint: boolean;
  supportsStreaming: boolean;
  supportsBatch: boolean;
  languages?: string[];
  available: boolean;
  unavailableReason?: string;
}

// ── Runtime connection descriptor (server-issued) ────────────────────────

/** Mirrors the `streaming` block of the runtime `GET /v1/config` response. */
export interface StreamingCapability {
  enabled: boolean;
  endpoint: string;
  protocolVersion: number;
  encodings: string[];
  sampleRates: number[];
  resample: boolean;
  channels: number[];
}

export interface DescriptorAuth {
  type: "token";
  value: string;
}

/**
 * Versioned connection descriptor for a local runtime, issued by `stt-server`.
 * The SDK accepts these descriptors; it never discovers hardware or supervises
 * runtimes itself.
 */
export interface RuntimeConnectionDescriptor {
  schemaVersion: 1;
  provider: "faster-whisper" | "whisper-cpp" | (string & {});
  protocol: "voice-typer-v1" | (string & {});
  transport: "http" | "websocket" | (string & {});
  baseUrl: string;
  streaming?: StreamingCapability;
  auth?: DescriptorAuth;
}

// ── Model information ────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name?: string;
  language?: string;
  sizeBytes?: number;
}

// ── Batch transcription ──────────────────────────────────────────────────

export interface BatchTranscriptionRequest {
  /** Audio blob or raw bytes to transcribe. */
  file: Blob | ArrayBuffer | Uint8Array;
  filename?: string;
  /** Context prompt (initial_prompt) — local runtime only. */
  prompt?: string;
  /** Language hint, where the provider supports it. */
  language?: string;
  /** Provider model identifier, where the provider supports it. */
  model?: string;
  signal?: AbortSignal;
}

export interface TranscriptionSegment {
  text: string;
  startMs: number;
  endMs: number;
  probability?: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments?: TranscriptionSegment[];
}

// ── Streaming session ────────────────────────────────────────────────────

export type SessionState = "idle" | "starting" | "active" | "stopping" | "closed";

/**
 * An active streaming transcription session. Events and state changes are
 * delivered through callbacks, mirroring the historical App provider seam.
 */
export interface StreamSession {
  readonly state: SessionState;
  onEvent: ((event: TranscriptEvent) => void) | null;
  onStateChange: ((state: SessionState) => void) | null;
  /** Send raw PCM audio (int16 little-endian). Buffered until the session is ready. */
  sendAudio(pcm: ArrayBuffer | Uint8Array): void;
  /** Graceful stop: flush final results, then close. */
  stop(): Promise<void>;
  /** Immediate stop: discard pending partials and close. */
  abort(): void;
}
