/**
 * Ollama's installed models (`GET /api/tags`), each described further by `POST /api/show` where the caller has it,
 * as registry entries. Everything Ollama runs is local and free.
 */

import type { CapabilityMatrix, ControlCapability } from "../capabilities";
import { canonicalOllamaTag, OLLAMA_PROVIDER, formatModelRef } from "../ref";
import type { OllamaShowResponse, OllamaTag, OllamaTagsResponse } from "../sources";
import type { ModelEntry, ModelTask } from "../types";
import { compact, localPrivacy } from "./shared";

/** `/api/show` answers per model name; a name without a tag is the `latest` one. */
export type OllamaShows = Readonly<Record<string, OllamaShowResponse>>;

const provided = (status: "supported" | "unsupported"): ControlCapability => ({ status, evidence: "provider_api" });
const unknown: ControlCapability = { status: "unknown" };

/**
 * What Ollama says the model can do. Newer Ollama lists `capabilities`; for an older one vision shows as a projector
 * (or a `.vision.` entry in the model info) and tools as `.Tools` in the template, and every model completes.
 */
function capabilityNames(show: OllamaShowResponse): string[] {
  if (Array.isArray(show.capabilities)) return show.capabilities.filter((name) => typeof name === "string");
  const found = ["completion"];
  const vision = (show.projector_info !== undefined && show.projector_info !== null) || Object.keys(show.model_info ?? {}).some((key) => key.includes(".vision."));
  if (vision) found.push("vision");
  if (show.template?.includes(".Tools")) found.push("tools");
  return found;
}

/** The model's own context window: `<architecture>.context_length` of the model info. */
function contextLength(show: OllamaShowResponse): number | undefined {
  const info = show.model_info ?? {};
  const architecture = info["general.architecture"];
  const key = typeof architecture === "string" && `${architecture}.context_length` in info ? `${architecture}.context_length` : Object.keys(info).find((name) => name.endsWith(".context_length"));
  const value = key === undefined ? undefined : info[key];
  return typeof value === "number" && value > 0 ? value : undefined;
}

function architectureOf(show: OllamaShowResponse): string | undefined {
  const architecture = show.model_info?.["general.architecture"];
  return typeof architecture === "string" ? architecture : undefined;
}

function entryOf(tag: OllamaTag, show: OllamaShowResponse | undefined): ModelEntry {
  const id = canonicalOllamaTag(tag.name);
  const names = show ? capabilityNames(show) : undefined;
  const embeddingOnly = names !== undefined && names.includes("embedding") && !names.includes("completion");
  const vision = names?.includes("vision") === true;
  const tasks: ModelTask[] = embeddingOnly ? ["text-embedding"] : vision ? ["text-to-text", "vision"] : ["text-to-text"];
  const kind = embeddingOnly ? ("embedding" as const) : ("llm" as const);
  const flag = (name: string) => (names ? provided(names.includes(name) ? "supported" : "unsupported") : unknown);
  const tokens = show ? contextLength(show) : undefined;
  const capabilities: CapabilityMatrix = {
    tools: flag("tools"),
    thinking: flag("thinking"),
    vision: flag("vision"),
    ...(tokens === undefined ? {} : { context_window: { ...provided("supported"), extra: { tokens } } }),
  };
  return compact({
    ref: formatModelRef({ kind, provider: OLLAMA_PROVIDER, id }),
    kind,
    provider: OLLAMA_PROVIDER,
    id,
    name: id,
    tasks,
    locality: "local" as const,
    access: "free" as const,
    privacy: localPrivacy(),
    capabilities,
    family: tag.details?.family,
    architecture: show ? architectureOf(show) : undefined,
    parameters: tag.details?.parameter_size,
    local: compact({ sizeBytes: tag.size, quant: tag.details?.quantization_level, digest: tag.digest }),
  });
}

/** The installed models of an Ollama as registry entries, in the order Ollama lists them. */
export function fromOllama(tags: OllamaTagsResponse, shows: OllamaShows = {}): ModelEntry[] {
  const byName = new Map(Object.entries(shows).map(([name, show]) => [canonicalOllamaTag(name), show]));
  return (tags.models ?? []).map((tag) => entryOf(tag, byName.get(canonicalOllamaTag(tag.name))));
}

