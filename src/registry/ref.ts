/**
 * Model references: `kind/provider/id`, the one string a workflow or a default stores. The id is whatever the provider
 * calls the model and may contain `/` and `:` (`custom-whisper-ab12cd34`, `hf.co/org/repo:Q4_K_M`, `llama3.2:latest`),
 * so only the first two `/` separate the parts.
 */

import { MODEL_KINDS, type ModelKind, type ModelRef } from "./types";

const KINDS: readonly string[] = MODEL_KINDS;
/** A provider id: `stt-server`, `ollama`, `openai`, `custom:3`. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]*$/;
// eslint-disable-next-line no-control-regex -- an id with a control character is never a real model id
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const STT_SERVER_PROVIDER = "stt-server";
export const OLLAMA_PROVIDER = "ollama";

/**
 * An Ollama name in its one canonical form: a name without a tag is the `latest` one (`llama3.2` is
 * `llama3.2:latest`). Only the part after the last `/` can carry a tag, since a registry host may carry a port
 * (`localhost:5000/library/llama3.2`).
 */
export function canonicalOllamaTag(tag: string): string {
  const name = tag.trim();
  if (!name) return name;
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? name : `${name}:latest`;
}

function canonicalId(provider: string, id: string): string {
  return provider === OLLAMA_PROVIDER ? canonicalOllamaTag(id) : id;
}

const validId = (id: string) => id.length > 0 && id === id.trim() && !CONTROL_CHARACTER.test(id);

/** The reference as a string. Throws on a part that cannot be one (an unknown kind, an empty id, a `/` in the provider). */
export function formatModelRef(ref: ModelRef): string {
  if (!KINDS.includes(ref.kind)) throw new Error(`Unknown model kind "${ref.kind}"`);
  if (!PROVIDER_ID.test(ref.provider)) throw new Error(`Invalid model provider "${ref.provider}"`);
  const id = canonicalId(ref.provider, ref.id);
  if (!validId(id)) throw new Error(`Invalid model id "${ref.id}"`);
  return `${ref.kind}/${ref.provider}/${id}`;
}

/** The parts of a reference, with the id in its canonical form; `null` when the text is not a reference. */
export function parseModelRef(text: string): ModelRef | null {
  const first = text.indexOf("/");
  const second = first < 0 ? -1 : text.indexOf("/", first + 1);
  if (second < 0) return null;
  const kind = text.slice(0, first);
  const provider = text.slice(first + 1, second);
  if (!KINDS.includes(kind) || !PROVIDER_ID.test(provider)) return null;
  const id = canonicalId(provider, text.slice(second + 1));
  return validId(id) ? { kind: kind as ModelKind, provider, id } : null;
}

/** The legacy flat id of a speech model (`sttModelId`, `capture.speechModelId`: a catalog slug or `custom-<slug>-<sha8>`). */
export function sttServerModelRef(id: string): string {
  return formatModelRef({ kind: "speech", provider: STT_SERVER_PROVIDER, id });
}

/** The legacy flat id of an AI model (`localModelId`: an Ollama tag, with or without `:latest`). */
export function ollamaModelRef(tag: string): string {
  return formatModelRef({ kind: "llm", provider: OLLAMA_PROVIDER, id: tag });
}
