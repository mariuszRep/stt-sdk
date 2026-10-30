/**
 * The capability vocabulary of the registry: stt-server's tri-state matrix (client-contract.md §4.1) as THE shape for
 * every model, extended with the controls the other kinds need. `toBooleans` derives the SDK's simple
 * {@link ModelCapabilities} view from it (an `unknown` status is *not* supported, as before).
 */

import type { ModelCapabilities } from "../types";

export const CAPABILITY_STATUSES = ["supported", "unsupported", "unknown"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/**
 * Where a status comes from. `loaded_model` is the engine's answer for a loaded model, `gguf_header` a drop-in model's
 * own file, `provider_api` a provider's own listing (Ollama `/api/show`), `learned` a downgrade a call taught us,
 * `cloud_claim` our data file, `builtin` code compiled into the server. A source may send others: the field is open.
 */
export const CAPABILITY_EVIDENCE = [
  "catalog_claim",
  "gguf_header",
  "loaded_model",
  "provider_api",
  "learned",
  "cloud_claim",
  "builtin",
] as const;
export type CapabilityEvidence = (typeof CAPABILITY_EVIDENCE)[number];

/** The controls stt-server reports for a speech model (`word_timestamps` is read by the SDK when a server sends it). */
export const SPEECH_CONTROLS = [
  "prompt",
  "temperature",
  "language_hint",
  "language_detect",
  "translation",
  "timestamp_granularity",
  "word_timestamps",
  "streaming",
  "response_formats",
  "punctuation",
  "itn",
  "cancellation",
  "long_form",
  "spec_decode",
  "native_sample_rate",
] as const;

/** The controls the registry adds for the other kinds of model; `context_window` carries `extra.tokens`. */
export const ADDED_CONTROLS = [
  "diarization",
  "speaker_embedding",
  "tools",
  "thinking",
  "vision",
  "json_schema",
  "system_role",
  "context_window",
  "text_streaming",
] as const;

export const CAPABILITY_CONTROLS = [...SPEECH_CONTROLS, ...ADDED_CONTROLS] as const;
export type CapabilityControl = (typeof CAPABILITY_CONTROLS)[number];

/**
 * One control as a server or provider reports it. Servers flatten a control's extras onto it (`languages`,
 * `target_languages`, `max`); some nest them under `extra`: both are read.
 */
export interface ControlCapability {
  status?: CapabilityStatus | (string & {});
  reason?: string | null;
  evidence?: CapabilityEvidence | (string & {});
  mechanism?: string | null;
  /** What the catalog or model file claims, before the engine confirmed it. */
  model_claim?: unknown;
  extra?: Record<string, unknown>;
  /** `translation`: the languages the model translates into; `null` when it translates but does not say. */
  target_languages?: string[] | null;
  /** `language_hint`: the languages the model understands. */
  languages?: string[];
  /** `timestamp_granularity`: the finest granularity the model reports (`word`, `segment`, ...). */
  max?: string;
  [key: string]: unknown;
}

export type CapabilityMatrix = Record<string, ControlCapability>;

/**
 * `language_hint`'s extra fields (client-contract.md §4.1): the live view flattens `languages` onto the control; the
 * catalog (unloaded) view reports its static claim under `model_claim`. Some server versions nest either under
 * `extra`, so both shapes are accepted.
 */
interface LanguageHintCapability extends ControlCapability {
  model_claim?: string[];
  extra?: { languages?: string[]; model_claim?: string[] };
}

const supported = (control?: ControlCapability): boolean => control?.status === "supported";

/**
 * Whether a model can do what the control stands for (stream live, translate). Unlike the other controls, an
 * unconfirmed (`"unknown"`) status counts when the catalog claims it: nothing is sent that a model could reject, and a
 * model that cannot is refused by the server (`streaming_unsupported`, `unsupported_capability`), which the caller
 * answers by transcribing in batch or refreshing the model list. Waiting for the engine to confirm would make the first
 * recording after a start always batch, and a translation setting on a model that is not loaded yet unusable.
 */
function confirmedOrClaimed(control?: ControlCapability): boolean {
  return control?.status === "supported" || (control?.status === "unknown" && control.model_claim === true);
}

/** Whether an unconfirmed `language_hint` carries a list of languages the catalog claims the model understands. */
function claimsLanguages(control?: LanguageHintCapability): boolean {
  return control?.status === "unknown" && Array.isArray(control.model_claim) && control.model_claim.length > 0;
}

/**
 * Simple supported/not-supported booleans for the optional per-request controls. `"supported"` is true; `"unknown"`
 * (the catalog has no claim, or the engine has not looked at the loaded file) and `"unsupported"` are both *not*
 * supported — the SDK never sends an optional field it cannot confirm the model accepts, per the contract's "clients
 * omit unsupported or unknown controls" rule (§4.3). Once the model has been loaded, the server's live view replaces
 * `"unknown"` with a verified answer, and this picks that up on the next list.
 */
export function toBooleans(raw: CapabilityMatrix | undefined): ModelCapabilities {
  const translates = confirmedOrClaimed(raw?.translation);
  const translationTargets = translates ? raw?.translation?.target_languages : undefined;
  return {
    prompt: supported(raw?.prompt),
    // Like translation, a model that is not loaded yet reports the languages it claims (`unknown` status): that is
    // enough to send the hint, which the server refuses for a model that cannot take it.
    languageHint: supported(raw?.language_hint) || claimsLanguages(raw?.language_hint as LanguageHintCapability | undefined),
    languageDetect: supported(raw?.language_detect),
    translation: translates,
    // Only a non-empty list is a real answer: `null` is "not advertised" (English only) and `[]` is "none".
    ...(translationTargets?.length ? { translationTargets } : {}),
    streaming: confirmedOrClaimed(raw?.streaming),
    temperature: supported(raw?.temperature),
    timestamps: {
      // `timestamp_granularity` gates `timestamp_granularities=segment`; `word_timestamps`
      // gates the `word` value specifically (client-contract.md §4.1, §4.3).
      segment: supported(raw?.timestamp_granularity),
      word: supported(raw?.word_timestamps),
    },
  };
}

/**
 * The model's supported language codes from its matrix: the live `language_hint.languages`, else the catalog's
 * `model_claim` (flattened or under `extra`).
 */
export function languagesOfMatrix(raw: CapabilityMatrix | undefined): string[] | undefined {
  const hint = raw?.language_hint as LanguageHintCapability | undefined;
  return hint?.languages ?? hint?.extra?.languages ?? hint?.model_claim ?? hint?.extra?.model_claim;
}

/**
 * A matrix every control of which has a `status`, as the registry stores it. A server's matrix can also carry plain
 * facts that are not controls (a loaded model's `arch`, `whisper_ext_accepted`): they are left out. stt-server's
 * `response_formats` is the one control that is a plain map (`{"json":"supported",...}`): it becomes `supported`
 * when any format is, with the map kept in `extra.values`.
 */
export function normalizeMatrix(raw: Record<string, unknown> | undefined): CapabilityMatrix {
  const matrix: CapabilityMatrix = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const control = value as ControlCapability;
    if (typeof control.status === "string") {
      matrix[name] = control;
      continue;
    }
    const anySupported = Object.values(control).some((entry) => entry === "supported");
    matrix[name] = { status: anySupported ? "supported" : "unknown", extra: { values: control } };
  }
  return matrix;
}
