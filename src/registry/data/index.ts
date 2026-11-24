import cloudModelsJson from "./cloud-models.json";
import providersJson from "./providers.json";
import { fromCloudCatalog } from "../adapters/cloud";
import type { CloudModelCatalog, ModelEntry, ProviderCatalog } from "../types";

// The JSON files are checked against the schema by the SDK's tests, so the types below are what they hold.

/** The built-in providers: Ollama, the cloud providers and the template custom endpoints are made from. Data, never user settings. */
export const BUILTIN_PROVIDERS = providersJson as ProviderCatalog;

/** The known cloud models, a short list per provider; a provider that takes any model id (`modelIdFreeText`) accepts others too. */
export const KNOWN_CLOUD_MODELS = cloudModelsJson as CloudModelCatalog;

/** The known cloud models as registry entries: `locality: "cloud"`, `access: "plus"`, with what leaves the computer. */
export function listCloudEntries(): ModelEntry[] {
  return fromCloudCatalog(KNOWN_CLOUD_MODELS, BUILTIN_PROVIDERS.providers);
}
