/**
 * stt-server rows as registry entries: `GET /models/manage` (the whole catalog and what is installed) and
 * `GET /v1/models` (only the callable models, with the live capabilities).
 */

import { languagesOfMatrix, normalizeMatrix } from "../capabilities";
import { STT_SERVER_PROVIDER, sttServerModelRef } from "../ref";
import { getModelDisplaySizeBytes, type ManagedModel, type SttServerCatalogText, type SttServerLabels, type SttServerV1Model } from "../sources";
import { PRIMARY_TASK, type ModelEditorial, type ModelEntry, type ModelState } from "../types";
import { compact, localPrivacy } from "./shared";

/** The reference of a row: the server's own, else the one an older server's `id` makes. */
const refOf = (row: SttServerLabels & { id: string }): string => row.ref ?? sttServerModelRef(row.id);

/**
 * The registry identity of a row. A current server labels every row (client-contract.md §4.5) and its labels win; for an
 * older one the row is what the server has always served, a local speech model.
 */
function labelsOf(row: SttServerLabels & { id: string }) {
  const kind = row.kind ?? "speech";
  return {
    ref: refOf(row),
    kind,
    provider: row.provider ?? STT_SERVER_PROVIDER,
    tasks: row.tasks?.length ? row.tasks : [PRIMARY_TASK[kind]],
    locality: row.locality ?? ("local" as const),
    privacy: row.privacy ?? localPrivacy(),
  };
}

/** The catalog text a current server sends (a drop-in has none of it). */
const catalogTextOf = (row: SttServerCatalogText) => ({
  description: row.description,
  parameters: row.parameters,
  baseModel: row.base_model,
  languageCount: row.language_count,
});

function editorialOf(row: ManagedModel): ModelEditorial | undefined {
  const rank = row.recommended_rank ?? undefined;
  // A current server says whether a model is recommended (five models have a rank without being recommended); an older
  // one sent the rank of a recommended model only, so a rank meant recommended.
  const recommended = row.recommended ?? (rank === undefined ? undefined : true);
  if (recommended === undefined && row.speed_score == null && row.accuracy_score == null) return undefined;
  // A catalog row without a flag or a rank is not recommended.
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
    ...labelsOf(row),
    id: row.id,
    name: row.name,
    ...catalogTextOf(row),
    access: "free" as const,
    capabilities: normalizeMatrix(row.effective_capabilities),
    family: row.family,
    architecture: row.architecture,
    license: row.license,
    languages: row.languages,
    local: Object.keys(local).length ? local : undefined,
    editorial: editorialOf(row),
  });
}

/** What a `/models/manage` row says about the model now. */
export function sttServerManagedState(row: ManagedModel): ModelState {
  return compact({
    ref: refOf(row),
    installed: row.downloaded,
    needsVerification: row.needs_verification,
    default: row.default,
    installedQuant: row.installed_quant,
  });
}

/**
 * One `/v1/models` entry as a registry entry. The catalog fields the manage view has (files, scores, license) are not
 * in it, though a current server does send the labels and the catalog text; the capabilities are the live ones where the
 * server has loaded the model. As in `SttServerProvider`, the top-level `language_detect` and `languages` win over the
 * matrix.
 */
export function fromSttServerV1Model(model: SttServerV1Model): ModelEntry {
  const capabilities = normalizeMatrix(model.capabilities);
  if (typeof model.language_detect === "boolean") {
    capabilities.language_detect = { ...capabilities.language_detect, status: model.language_detect ? "supported" : "unsupported" };
  }
  const architecture = (model.capabilities as Record<string, unknown> | undefined)?.arch;
  return compact({
    ...labelsOf(model),
    id: model.id,
    name: model.name?.trim() ? model.name : model.id,
    ...catalogTextOf(model),
    access: "free" as const,
    capabilities,
    architecture: typeof architecture === "string" ? architecture : undefined,
    languages: model.languages ?? languagesOfMatrix(model.capabilities),
  });
}

/** A callable model is installed and verified. */
export function sttServerV1State(model: SttServerV1Model): ModelState {
  return { ref: refOf(model), installed: true, default: model.default === true };
}
