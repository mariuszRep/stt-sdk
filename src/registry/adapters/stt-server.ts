/**
 * stt-server rows as registry entries: `GET /models/manage` (the whole catalog and what is installed) and
 * `GET /v1/models` (only the callable models, with the live capabilities).
 */

import { languagesOfMatrix, normalizeMatrix } from "../capabilities";
import { STT_SERVER_PROVIDER, sttServerModelRef } from "../ref";
import { getModelDisplaySizeBytes, type ManagedModel, type SttServerV1Model } from "../sources";
import type { ModelEditorial, ModelEntry, ModelState } from "../types";
import { compact, localPrivacy } from "./shared";

function editorialOf(row: ManagedModel): ModelEditorial | undefined {
  const rank = row.recommended_rank ?? undefined;
  const recommended = row.recommended ?? (rank === undefined ? undefined : true);
  if (recommended === undefined && row.speed_score == null && row.accuracy_score == null) return undefined;
  // `/models/manage` carries the rank of a recommended model only, so a catalog row without one is not recommended.
  return compact({
    recommended: recommended ?? false,
    recommendedRank: rank,
    speedScore: row.speed_score ?? undefined,
    accuracyScore: row.accuracy_score ?? undefined,
    source: "handy" as const,
  });
}

/** One `/models/manage` row (a catalog model or a drop-in) as a registry entry. */
export function fromSttServerManaged(row: ManagedModel): ModelEntry {
  const sizeBytes = getModelDisplaySizeBytes(row) ?? undefined;
  const local = compact({
    files: row.files?.map((file) => compact({ filename: file.filename, quant: file.quant, sizeBytes: file.size_bytes, sha256: file.sha256 })),
    revision: row.revision,
    upstreamId: row.upstream_id,
    defaultQuant: row.default_quant ?? undefined,
    sizeBytes,
    source: row.source,
    custom: row.custom,
  });
  return compact({
    ref: sttServerModelRef(row.id),
    kind: "speech" as const,
    provider: STT_SERVER_PROVIDER,
    id: row.id,
    name: row.name,
    description: row.description,
    tasks: ["speech-to-text" as const],
    locality: "local" as const,
    access: "free" as const,
    privacy: localPrivacy(),
    capabilities: normalizeMatrix(row.effective_capabilities),
    family: row.family,
    architecture: row.architecture,
    parameters: row.parameters,
    baseModel: row.base_model,
    license: row.license,
    languages: row.languages,
    local: Object.keys(local).length ? local : undefined,
    editorial: editorialOf(row),
  });
}

/** What a `/models/manage` row says about the model now. */
export function sttServerManagedState(row: ManagedModel): ModelState {
  return compact({
    ref: sttServerModelRef(row.id),
    installed: row.downloaded,
    needsVerification: row.needs_verification,
    default: row.default,
    installedQuant: row.installed_quant,
  });
}

/**
 * One `/v1/models` entry as a registry entry. The catalog fields the manage view has (files, scores, license) are not
 * in it; the capabilities are the live ones where the server has loaded the model. As in `SttServerProvider`, the
 * top-level `language_detect` and `languages` win over the matrix.
 */
export function fromSttServerV1Model(model: SttServerV1Model): ModelEntry {
  const capabilities = normalizeMatrix(model.capabilities);
  if (typeof model.language_detect === "boolean") {
    capabilities.language_detect = { ...capabilities.language_detect, status: model.language_detect ? "supported" : "unsupported" };
  }
  const architecture = (model.capabilities as Record<string, unknown> | undefined)?.arch;
  return compact({
    ref: sttServerModelRef(model.id),
    kind: "speech" as const,
    provider: STT_SERVER_PROVIDER,
    id: model.id,
    name: model.name?.trim() ? model.name : model.id,
    tasks: ["speech-to-text" as const],
    locality: "local" as const,
    access: "free" as const,
    privacy: localPrivacy(),
    capabilities,
    architecture: typeof architecture === "string" ? architecture : undefined,
    languages: model.languages ?? languagesOfMatrix(model.capabilities),
  });
}

/** A callable model is installed and verified. */
export function sttServerV1State(model: SttServerV1Model): ModelState {
  return { ref: sttServerModelRef(model.id), installed: true, default: model.default === true };
}
