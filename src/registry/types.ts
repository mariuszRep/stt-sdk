/**
 * The model registry's types: ONE list of every model the estate uses, whatever serves it (a local stt-server, Ollama,
 * a cloud API). Each entry carries flags: where it runs (`locality`), what it does (`tasks`, a model can have several)
 * and what it can be asked to do (`capabilities`). The JSON Schema in `schema/model-entry.v1.json` describes the same
 * shape; a test keeps the two together.
 */

import type { CapabilityMatrix } from "./capabilities";

export const MODEL_ENTRY_SCHEMA_VERSION = 1;

/**
 * The primary kind of a model: the one part of its reference (`kind/provider/id`). A model that does several things
 * has several `tasks` but one kind (a vision-capable chat model is `llm`; its `tasks` say it also reads pictures).
 * `tts` and `embedding` are reserved: nothing in the estate serves them yet.
 */
export const MODEL_KINDS = ["speech", "llm", "speaker", "vad", "denoise", "tts", "embedding"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/**
 * What a model does: the flags of the one list. An entry has one or more; it always has the task of its own kind
 * (see {@link PRIMARY_TASK}). Additive: a new task never changes an existing entry.
 */
export const MODEL_TASKS = [
  "speech-to-text",
  "text-to-text",
  "vision",
  "text-to-speech",
  "text-embedding",
  "speaker-embedding",
  "voice-activity-detection",
  "denoise",
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

/** The task every entry of a kind carries. */
export const PRIMARY_TASK: Readonly<Record<ModelKind, ModelTask>> = {
  speech: "speech-to-text",
  llm: "text-to-text",
  speaker: "speaker-embedding",
  vad: "voice-activity-detection",
  denoise: "denoise",
  tts: "text-to-speech",
  embedding: "text-embedding",
};

/** Where a model runs. `cloud` is anything that leaves this computer. */
export const MODEL_LOCALITIES = ["local", "cloud"] as const;
export type ModelLocality = (typeof MODEL_LOCALITIES)[number];

/** Who may use a model; every cloud model is `plus` (your own key), local ones are `free`. */
export const MODEL_ACCESS = ["free", "plus"] as const;
export type ModelAccess = (typeof MODEL_ACCESS)[number];

/** What leaves this computer when the model is used. */
export const PRIVACY_SENDS = ["audio", "text", "context", "images"] as const;
export type PrivacySend = (typeof PRIVACY_SENDS)[number];

export interface ModelPrivacy {
  /** Empty for a model that runs on this computer. */
  sends: PrivacySend[];
  /** The host the data goes to, for a cloud model (`api.openai.com`). */
  to?: string;
}

/**
 * A reference to one model: the only thing a workflow or a default stores, written `kind/provider/id`
 * (`speech/stt-server/parakeet-tdt-0.6b-v2`, `llm/ollama/llama3.2:latest`). The id may itself contain `/` and `:`.
 */
export interface ModelRef {
  kind: ModelKind;
  /** A provider id: `stt-server`, `ollama`, `openai`, `custom:<n>`, ... (see {@link ProviderDescriptor}). */
  provider: string;
  /** The provider's own id for the model: a catalog slug, an Ollama tag, a cloud model id. */
  id: string;
}

export interface LocalModelFile {
  filename: string;
  quant: string;
  sizeBytes?: number;
  sha256?: string;
}

/**
 * What a locally stored model is made of. Absent for a cloud model. A built-in (compiled into the server) has no
 * download, but its weights are still described here: `files` carries their size and SHA-256.
 */
export interface LocalModelInfo {
  files?: LocalModelFile[];
  /** The pinned upstream revision the files were taken from. */
  revision?: string;
  /** The upstream repository id (stt-server: `handy-computer/whisper-tiny-gguf`). */
  upstreamId?: string;
  defaultQuant?: string;
  /** The size to show: the default quant's file, or the whole model where there are no files. */
  sizeBytes?: number;
  /** Ollama: the model's own quantization and content digest. */
  quant?: string;
  digest?: string;
  /** stt-server: how it got here (`catalog_download`, `import`, `user_folder`). */
  source?: string;
  /** A file the user dropped in, not a catalog entry. */
  custom?: boolean;
}

/** Cloud-only extras; the endpoint and the auth come from the provider. */
export interface CloudModelInfo {
  /** The provider takes any model id typed in, so this list is a convenience. */
  modelIdFreeText?: boolean;
  pricingNote?: string;
}

/** What we say about a model beyond what it is: curated by us or by the catalog's source. */
export interface ModelEditorial {
  recommended?: boolean;
  recommendedRank?: number | null;
  /** 0-100 derived display scores, not local measurements. */
  speedScore?: number | null;
  accuracyScore?: number | null;
  source: "handy" | "stanzo";
}

/** One model of the one list. */
export interface ModelEntry {
  /** `kind/provider/id` — equals `formatModelRef({ kind, provider, id })`. */
  ref: string;
  kind: ModelKind;
  provider: string;
  id: string;
  name: string;
  description?: string;
  /** What the model does; at least the task of its kind. */
  tasks: ModelTask[];
  locality: ModelLocality;
  access: ModelAccess;
  privacy: ModelPrivacy;
  /** What it can be asked to do: one tri-state map, see `capabilities.ts`. */
  capabilities: CapabilityMatrix;
  family?: string;
  architecture?: string;
  /** Size class as the source writes it (`0.6B`, `3.2B`). */
  parameters?: string;
  baseModel?: string;
  license?: string;
  /** ISO codes. */
  languages?: string[];
  /** How many languages the catalog counts for the model, as the source states it (a drop-in has none). */
  languageCount?: number;
  local?: LocalModelInfo;
  /** Compiled into the app or the server: always installed, nothing to download (`local.files` still names its weights). */
  builtin?: boolean;
  cloud?: CloudModelInfo;
  editorial?: ModelEditorial;
}

/** What a workflow needs to know before it can use a model. One answer shared by the run and the UI. */
export const READINESS_VALUES = [
  "ready",
  "no_model",
  "not_installed",
  "needs_key",
  "key_rejected",
  "unreachable",
  "needs_plus",
] as const;
export type Readiness = (typeof READINESS_VALUES)[number];

/** The live part of a model, merged in by whoever has it: not part of the catalog, never stored in an entry. */
export interface ModelState {
  ref: string;
  installed: boolean;
  needsVerification?: boolean;
  downloading?: boolean;
  loaded?: boolean;
  needsKey?: boolean;
  reachable?: boolean;
  /** The default model of its kind (for stt-server: the server's starred model). */
  default: boolean;
  /** stt-server: the quantization on disk. */
  installedQuant?: string | null;
}

// ── Providers ────────────────────────────────────────────────────────────

/** The wire protocol a provider speaks. */
export const PROVIDER_APIS = [
  "stt-server",
  "ollama",
  "openai-chat",
  "anthropic-messages",
  "openai-audio",
  "deepgram-listen",
  "app-builtin",
] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** How a key is sent. `token` is Deepgram's `Authorization: Token <key>`. */
export const PROVIDER_AUTH_TYPES = ["none", "bearer", "x-api-key", "token", "query"] as const;
export type ProviderAuthType = (typeof PROVIDER_AUTH_TYPES)[number];

export interface ProviderAuth {
  type: ProviderAuthType;
  /** Where the user gets a key. */
  keyUrl?: string;
}

/** How to switch a model's reasoning off for a latency-critical call; the caller maps the name to the request field. */
export const REASONING_OFF_QUIRKS = [
  "reasoning_effort_none",
  "reasoning_exclude",
  "chat_template_enable_thinking_false",
  "think_false",
  "native_budget_0",
  "none",
] as const;
export type ReasoningOffQuirk = (typeof REASONING_OFF_QUIRKS)[number];

/** Per-provider quirks of an LLM endpoint, named switches the one client applies (never sniffed from the id). */
export interface ProviderQuirks {
  reasoningOff: ReasoningOffQuirk;
  /** `fold`: the system prompt goes into the first user turn. */
  systemRole: "system" | "fold";
  structuredOutput: "json_schema" | "json_object" | "none";
  /** The models list returns `models/<id>`; strip the prefix. */
  stripModelsPrefix?: boolean;
  extraHeaders?: Record<string, string>;
}

export interface ProviderTimeouts {
  connectMs: number;
  firstByteMs: number;
  stallMs: number;
  /** A one-shot call (the AI step's transform). */
  totalMs: number;
  /** A background job (a summary): longer. */
  longRunMs?: number;
}

export interface ProviderRetry {
  statuses: number[];
  max: number;
  backoffMs: number;
}

/** One kind of model a provider serves, with the endpoint that serves it. */
export interface ProviderService {
  kind: ModelKind;
  api: ProviderApi;
  baseUrl: string;
  /** The user may point the service at another URL (a custom endpoint, a server on the network). */
  baseUrlEditable: boolean;
  /** Where the provider lists its models, if it does. */
  modelsEndpoint: string | null;
  /** Any model id typed in is accepted, so the known list is a convenience. */
  modelIdFreeText: boolean;
  privacy: ModelPrivacy;
  quirks?: ProviderQuirks;
  timeouts?: ProviderTimeouts;
  retry?: ProviderRetry;
}

/**
 * A provider of models: data, never code. Built-ins ship in `providers.json`; a user's custom endpoints are user data
 * built from the `template` one (`custom:<n>`, locality by host: a loopback address is local and free).
 */
export interface ProviderDescriptor {
  id: string;
  name: string;
  locality: ModelLocality;
  access: ModelAccess;
  /** One key per provider, shared by every service. */
  auth: ProviderAuth;
  /** The kinds of model it serves; a provider can serve several, each over its own endpoint. */
  serves: ProviderService[];
  /** Not a provider itself: the form a user's custom endpoints are made from. */
  template?: boolean;
}

// ── Known cloud models (data) ────────────────────────────────────────────

/** One known model of a cloud provider, as `cloud-models.json` lists it. Everything but the id is a claim of ours. */
export interface CloudModelRecord {
  provider: string;
  kind: ModelKind;
  id: string;
  name: string;
  description?: string;
  /** Besides the task of its kind (`vision` for a model that reads pictures). */
  tasks?: ModelTask[];
  contextWindow?: number;
  languages?: string[];
  /** `true`: the model supports it; `false`: it does not; absent: not claimed. */
  claims?: CloudModelClaims;
  pricingNote?: string;
}

/** The capability claims a cloud model's record can make, each a boolean. */
export interface CloudModelClaims {
  tools?: boolean;
  thinking?: boolean;
  jsonSchema?: boolean;
  systemRole?: boolean;
  textStreaming?: boolean;
  languageHint?: boolean;
  prompt?: boolean;
  temperature?: boolean;
  timestamps?: boolean;
  translation?: boolean;
  streaming?: boolean;
}

/**
 * The version of a model catalog. The SDK's own data files (`providers.json`, `cloud-models.json`) use the date they
 * were reviewed (`2026-10-30`); stt-server numbers the catalog it embeds (`2`). Compare only like with like.
 */
export type CatalogVersion = number | string;

export interface CloudModelCatalog {
  schemaVersion: typeof MODEL_ENTRY_SCHEMA_VERSION;
  /** When the list was last reviewed, as a date. */
  catalogVersion: string;
  models: CloudModelRecord[];
}

export interface ProviderCatalog {
  schemaVersion: typeof MODEL_ENTRY_SCHEMA_VERSION;
  catalogVersion: string;
  providers: ProviderDescriptor[];
}
