/**
 * The known cloud models (`cloud-models.json`) as registry entries. What a provider is and where it lives comes from
 * its descriptor; what a model can do is our claim (`cloud_claim`), never something a call proved.
 */

import type { CapabilityMatrix, ControlCapability } from "../capabilities";
import { formatModelRef } from "../ref";
import {
  PRIMARY_TASK,
  type CloudModelCatalog,
  type CloudModelClaims,
  type CloudModelRecord,
  type ModelEntry,
  type ModelTask,
  type PrivacySend,
  type ProviderDescriptor,
} from "../types";
import { compact } from "./shared";

/** The control each claim stands for. */
const CLAIM_CONTROLS: Readonly<Record<keyof CloudModelClaims, string>> = {
  tools: "tools",
  thinking: "thinking",
  jsonSchema: "json_schema",
  systemRole: "system_role",
  textStreaming: "text_streaming",
  languageHint: "language_hint",
  prompt: "prompt",
  temperature: "temperature",
  timestamps: "timestamp_granularity",
  translation: "translation",
  streaming: "streaming",
};

const claimed = (supported: boolean): ControlCapability => ({ status: supported ? "supported" : "unsupported", evidence: "cloud_claim" });

function capabilitiesOf(record: CloudModelRecord, tasks: readonly ModelTask[]): CapabilityMatrix {
  const matrix: CapabilityMatrix = {};
  for (const [claim, control] of Object.entries(CLAIM_CONTROLS)) {
    const value = record.claims?.[claim as keyof CloudModelClaims];
    if (value !== undefined) matrix[control] = claimed(value);
  }
  if (tasks.includes("vision")) matrix.vision = claimed(true);
  if (record.contextWindow !== undefined) matrix.context_window = { ...claimed(true), extra: { tokens: record.contextWindow } };
  return matrix;
}

function entryOf(record: CloudModelRecord, provider: ProviderDescriptor): ModelEntry {
  const service = provider.serves.find((candidate) => candidate.kind === record.kind);
  if (!service) throw new Error(`Provider "${provider.id}" does not serve ${record.kind} models (model "${record.id}")`);
  const tasks = [...new Set<ModelTask>([PRIMARY_TASK[record.kind], ...(record.tasks ?? [])])];
  // A picture is part of what a vision model is sent.
  const sends = [...new Set<PrivacySend>([...service.privacy.sends, ...(tasks.includes("vision") ? (["images"] as const) : [])])];
  return compact({
    ref: formatModelRef({ kind: record.kind, provider: provider.id, id: record.id }),
    kind: record.kind,
    provider: provider.id,
    id: record.id,
    name: record.name,
    description: record.description,
    tasks,
    locality: provider.locality,
    access: provider.access,
    privacy: compact({ sends, to: service.privacy.to }),
    capabilities: capabilitiesOf(record, tasks),
    languages: record.languages,
    cloud: compact({ modelIdFreeText: service.modelIdFreeText, pricingNote: record.pricingNote }),
  });
}

/** The catalog's models as entries, in the catalog's order. A model of a provider that is not in `providers` is an error. */
export function fromCloudCatalog(catalog: CloudModelCatalog, providers: readonly ProviderDescriptor[]): ModelEntry[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return catalog.models.map((record) => {
    const provider = byId.get(record.provider);
    if (!provider) throw new Error(`Unknown provider "${record.provider}" for model "${record.id}"`);
    return entryOf(record, provider);
  });
}
