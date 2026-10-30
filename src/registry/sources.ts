/**
 * The shapes of the sources the registry's adapters read, as they come over the wire: stt-server's
 * `GET /models/manage` row and `GET /v1/models` entry, Ollama's `/api/tags` and `/api/show`. Fields are optional where
 * an older server or Ollama may leave them out.
 */

import type { CapabilityMatrix } from "./capabilities";
import type { ModelAccess } from "./types";

/** One entry from `GET /models/manage` — the full catalog + installed state, including not-yet-downloaded catalog entries
 * (unlike `GET /v1/models`, which only lists callable models). */
export interface ManagedModel {
  id: string;
  name: string;
  downloaded: boolean;
  default: boolean;
  source?: string;
  needs_verification?: boolean;
  recommended?: boolean;
  recommended_rank?: number | null;
  effective_capabilities?: CapabilityMatrix;
  /** The catalog's own flags for the model (`streaming` is true for a model that can transcribe a live stream). */
  model_capabilities?: { streaming?: boolean; translate?: boolean; lang_detect?: boolean };
  /** ISO codes of the languages the model understands. */
  languages?: string[];
  /** True for a model that runs online, so the audio leaves this computer. */
  cloud?: boolean;
  /** Who may use it; absent = free. No server labels a model yet: a "plus" here shows the Plus badge and locks it on Free. */
  access?: ModelAccess;
  size_bytes?: number | null;
  /** Model family (e.g. "parakeet", "whisper") -- used for onboarding's Parakeet-preselection fallback when the
   * exact preferred id isn't in the recommended list. */
  family?: string;
  architecture?: string;
  default_quant?: string | null;
  /** 0-100 derived display scores from the catalog's benchmark source, where available -- not a local measurement.
   * Used for onboarding's short speed/accuracy description. */
  accuracy_score?: number | null;
  speed_score?: number | null;
  files?: { filename: string; quant: string; size_bytes?: number; sha256?: string }[];
  /** The catalog's own description, parameter count and base model (served by stt-server from 0.3.7). */
  description?: string;
  parameters?: string;
  base_model?: string;
  license?: string;
  /** The upstream repository id and pinned revision the files come from. */
  upstream_id?: string;
  revision?: string;
  installed_quant?: string | null;
  /** A file the user dropped in: no catalog entry, its metadata is the GGUF header's. */
  custom?: boolean;
  [key: string]: unknown;
}

/** Best-effort download size for display: the catalog's own `size_bytes` when present, else the size of its default
 * (or first) quant file. Returns `null` when no size information is available at all -- callers should render
 * nothing rather than "undefined"/"NaN". */
export function getModelDisplaySizeBytes(model: ManagedModel): number | null {
  if (typeof model.size_bytes === "number") return model.size_bytes;
  const files = model.files;
  if (!files?.length) return null;
  const preferred = model.default_quant ? files.find((f) => f.quant === model.default_quant) : undefined;
  return (preferred ?? files[0])?.size_bytes ?? null;
}

/** One entry of `GET /v1/models` (OpenAI's shape plus the server's extensions): only callable models. */
export interface SttServerV1Model {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  default?: boolean;
  capabilities?: CapabilityMatrix;
  languages?: string[];
  language_detect?: boolean;
}

/** One entry of Ollama's `GET /api/tags`. */
export interface OllamaTag {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models?: OllamaTag[];
}

/** The parts of Ollama's `POST /api/show` the registry reads. */
export interface OllamaShowResponse {
  /** `completion`, `vision`, `tools`, `thinking`, `embedding`, `insert`, ... as Ollama names them (newer Ollama). */
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  projector_info?: unknown;
  template?: string;
  details?: OllamaTag["details"];
}
