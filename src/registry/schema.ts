import modelEntrySchema from "./schema/model-entry.v1.json";

/**
 * The JSON Schema (draft 2020-12) of a {@link ModelEntry}. Its `$defs` also describe `ModelState`, `ProviderDescriptor`,
 * the provider catalog, the cloud model catalog and stt-server's `GET /v1/registry` body (`#/$defs/modelState`,
 * `#/$defs/providerCatalog`, `#/$defs/registryDocument`, ...), so another language can validate every piece of the
 * registry against one file.
 */
export const MODEL_ENTRY_SCHEMA: Readonly<Record<string, unknown>> = modelEntrySchema;
