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
  /** stt-server's live streaming: `text` is `committed` (final, append-only) followed by `tentative` (may still change). */
  committed?: string;
  tentative?: string;
  /** Counts up with every change of `committed` or `tentative`. */
  revision?: number;
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
  /**
   * Translate each turn into this language (an stt-server extension). Needs a model with `capabilities.translation`;
   * a model that cannot stream translates per turn, so the text arrives whole after `stop()` instead of while
   * speaking. Unset: plain transcription.
   */
  targetLanguage?: string;
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
  /** Language codes this model supports, where the provider reports them. */
  languages?: string[];
  sizeBytes?: number;
  /** True for the model a request with no `model` field resolves to (server-reported). */
  isDefault?: boolean;
  /** Per-model capability booleans, derived conservatively from a server's status matrix. */
  capabilities?: ModelCapabilities;
}

/**
 * Simple supported/not-supported booleans for optional per-request controls,
 * derived from a server's richer status values (e.g. `"supported"` |
 * `"unsupported"` | `"unknown"`). An `"unknown"` status is treated as *not*
 * supported unless a specific server contract documents otherwise — the SDK
 * never sends an optional field it cannot confirm the model accepts.
 */
export interface ModelCapabilities {
  prompt?: boolean;
  languageHint?: boolean;
  /** Whether this model can auto-detect the spoken language. */
  languageDetect?: boolean;
  translation?: boolean;
  /**
   * The languages this model translates into, where it reports them. Absent for a translating model that does not
   * advertise its targets: such a model translates into English only.
   */
  translationTargets?: string[];
  /** Whether this model can transcribe live audio through `createStream`. */
  streaming?: boolean;
  temperature?: boolean;
  timestamps?: {
    segment?: boolean;
    word?: boolean;
  };
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
  /** Sampling temperature (0.0–1.0), where the chosen model supports it. */
  temperature?: number;
  /** Request word-level timestamps, where the chosen model supports it. */
  wordTimestamps?: boolean;
  signal?: AbortSignal;
}

/** A subtitle file format stt-server renders from the segment timestamps, named as in OpenAI's `response_format`. */
export type SubtitleFormat = "srt" | "vtt";

/**
 * Adds to a batch request: ask for a subtitle file instead of a {@link TranscriptionResult}. `SttServerProvider`'s
 * `transcribe` and `translate` then return the file's text. `wordTimestamps` is ignored.
 */
export interface SubtitleRequest {
  responseFormat: SubtitleFormat;
}

export interface TranscriptionSegment {
  text: string;
  startMs: number;
  endMs: number;
  probability?: number;
  words?: TranscriptWord[];
  /** Decode-time confidence signals, where the provider exposes them (local runtime only). */
  avgLogprob?: number;
  noSpeechProb?: number;
  compressionRatio?: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments?: TranscriptionSegment[];
  /** Raw server-side diagnostics (e.g. stt-server's `x_diagnostics`), passed through as-is. */
  diagnostics?: Record<string, unknown>;
}

/** Optional request for translating speech in another language (English unless `targetLanguage` says otherwise). */
export interface BatchTranslationRequest extends BatchTranscriptionRequest {
  /**
   * The language to translate into, one of the model's `capabilities.translationTargets` (English only when the model
   * reports none). Defaults to English, which is all OpenAI's translations endpoint offers; other targets are an
   * stt-server extension.
   */
  targetLanguage?: string;
}

// ── Offline speech detection ─────────────────────────────────────────────

/** Settings for {@link SttServerProvider.detectSpeech}; anything left out takes the server's default. */
export interface SpeechDetectionOptions {
  filename?: string;
  /** Speech probability from which a frame counts as speech, 0.05–0.95 (server default 0.5). */
  threshold?: number;
  /** Segments shorter than this are dropped (server default 250). */
  minSpeechMs?: number;
  /** A pause shorter than this does not split a segment (server default 100). */
  minSilenceMs?: number;
  /** Padding added to both ends of every segment (server default 30). */
  speechPadMs?: number;
  signal?: AbortSignal;
}

/** A stretch of speech, in seconds from the start of the audio. */
export interface SpeechSegment {
  start: number;
  end: number;
}

export interface SpeechDetectionResult {
  segments: SpeechSegment[];
  /** The share of the audio inside segments, 0–1. */
  speechRatio: number;
  /** Length of the audio in seconds. */
  duration: number;
}

// ── Speaker embeddings ───────────────────────────────────────────────────

/** Settings for {@link SttServerProvider.embedSpeakers}. */
export interface SpeakerEmbeddingOptions {
  filename?: string;
  /**
   * The stretches of the audio to fingerprint, in seconds. Left out, the server runs its own speech detection and
   * embeds every speech segment it finds. A segment shorter than 0.5 s gets no embedding.
   */
  segments?: SpeechSegment[];
  signal?: AbortSignal;
}

/** The voice fingerprint of one segment: `embedding` is null when the segment was too short to describe a voice. */
export interface SpeakerSegment extends SpeechSegment {
  embedding: number[] | null;
}

export interface SpeakerEmbeddingResult {
  /** The embedding space. Vectors from different models never compare; store it beside saved profiles. */
  model: string;
  /** Length of every embedding. */
  dim: number;
  /** Length of the audio in seconds. */
  duration: number;
  segments: SpeakerSegment[];
}

// ── Diarization ──────────────────────────────────────────────────────────

/** A voice the caller already has a profile for, given as an embedding from `embedSpeakers`. */
export interface KnownSpeakerEmbedding {
  /** What segments of this voice are labelled with (1-64 characters, distinct). */
  name: string;
  /** An embedding of the same model the server uses ({@link DiarizationResult.model} names it). */
  embedding: ArrayLike<number>;
}

/** A voice the caller has a recording of: a WAV clip of 2-10 s of that person speaking, which the server embeds. */
export interface KnownSpeakerReference {
  name: string;
  audio: Blob | ArrayBuffer | Uint8Array;
}

/** Settings for {@link SttServerProvider.diarize}. */
export interface DiarizationOptions {
  filename?: string;
  /** The speech to label, in seconds. Left out, the server runs its own speech detection. */
  segments?: SpeechSegment[];
  /** Two voices are one speaker at this cosine similarity or more (0.05-0.95). Default 0.4. */
  threshold?: number;
  /** At most this many speakers (1-26), merging voices past `threshold` if need be. Default 26. */
  maxSpeakers?: number;
  /**
   * Up to 26 known voices to name, by embedding or (at most four) by reference clip; the two kinds do not mix. A
   * speaker whose voice matches (at `threshold`) gets the name, any other "A", "B", ... in order of appearance.
   */
  knownSpeakers?: KnownSpeakerEmbedding[] | KnownSpeakerReference[];
  signal?: AbortSignal;
}

/** Who spoke between `start` and `end`: the shape of an element of OpenAI's `diarized_json` segments, without text. */
export interface DiarizedSegment extends SpeechSegment {
  type: "transcript.text.segment";
  id: string;
  /** "A", "B", ... or the name of a known speaker. */
  speaker: string;
}

export interface DiarizationResult {
  /** The engine that produced the labels. */
  model: string;
  /** Length of the audio in seconds. */
  duration: number;
  /** In time order; a segment under 0.5 s is too short to attribute and is left out. There is no text. */
  segments: DiarizedSegment[];
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
