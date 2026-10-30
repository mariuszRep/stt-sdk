/**
 * `@open-vibe-ai/stt-sdk/registry`: the model registry. One standard list of every model the estate uses (local and
 * cloud, speech and AI), each with flags for where it runs and what it does, plus the adapters that turn what stt-server,
 * Ollama and the cloud catalog say into that list.
 */

export {
  MODEL_ENTRY_SCHEMA_VERSION,
  MODEL_KINDS,
  MODEL_TASKS,
  PRIMARY_TASK,
  MODEL_LOCALITIES,
  MODEL_ACCESS,
  PRIVACY_SENDS,
  READINESS_VALUES,
  PROVIDER_APIS,
  PROVIDER_AUTH_TYPES,
  REASONING_OFF_QUIRKS,
} from "./types";
export type {
  ModelKind,
  ModelTask,
  ModelLocality,
  ModelAccess,
  PrivacySend,
  ModelPrivacy,
  ModelRef,
  LocalModelFile,
  LocalModelInfo,
  CloudModelInfo,
  ModelEditorial,
  ModelEntry,
  CatalogVersion,
  Readiness,
  ModelState,
  ProviderApi,
  ProviderAuthType,
  ProviderAuth,
  ReasoningOffQuirk,
  ProviderQuirks,
  ProviderTimeouts,
  ProviderRetry,
  ProviderService,
  ProviderDescriptor,
  CloudModelRecord,
  CloudModelClaims,
  CloudModelCatalog,
  ProviderCatalog,
} from "./types";

export {
  CAPABILITY_STATUSES,
  CAPABILITY_EVIDENCE,
  SPEECH_CONTROLS,
  ADDED_CONTROLS,
  CAPABILITY_CONTROLS,
  toBooleans,
  languagesOfMatrix,
  normalizeMatrix,
} from "./capabilities";
export type { CapabilityStatus, CapabilityEvidence, CapabilityControl, ControlCapability, CapabilityMatrix } from "./capabilities";

export { STT_SERVER_PROVIDER, OLLAMA_PROVIDER, canonicalOllamaTag, formatModelRef, parseModelRef, sttServerModelRef, ollamaModelRef } from "./ref";

export type {
  ManagedModel,
  SttServerLabels,
  SttServerCatalogText,
  SttServerV1Model,
  SttServerCatalogStamp,
  SttServerRegistryDocument,
  OllamaTag,
  OllamaTagsResponse,
  OllamaShowResponse,
} from "./sources";

export { fromSttServerManaged, fromSttServerV1Model, sttServerManagedState, sttServerV1State } from "./adapters/stt-server";
export { fromOllama } from "./adapters/ollama";
export type { OllamaShows } from "./adapters/ollama";
export { fromCloudCatalog } from "./adapters/cloud";

export { MODEL_ENTRY_SCHEMA } from "./schema";
export { BUILTIN_PROVIDERS, KNOWN_CLOUD_MODELS, listCloudEntries } from "./data";
