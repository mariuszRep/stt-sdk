import Ajv2020 from "ajv/dist/2020";
import { MODEL_ENTRY_SCHEMA } from "../src/registry";

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addSchema(MODEL_ENTRY_SCHEMA);
const base = String(MODEL_ENTRY_SCHEMA.$id);

type Check = (value: unknown) => string[];

function checker(pointer: string): Check {
  const validate = ajv.getSchema(base + pointer);
  if (!validate) throw new Error(`No schema at ${pointer}`);
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`));
}

/** The problems of a value against the registry's JSON Schema (empty = valid). */
export const entryProblems = checker("");
export const stateProblems = checker("#/$defs/modelState");
export const registryDocumentProblems = checker("#/$defs/registryDocument");
export const providerProblems = checker("#/$defs/providerDescriptor");
export const providerCatalogProblems = checker("#/$defs/providerCatalog");
export const cloudCatalogProblems = checker("#/$defs/cloudModelCatalog");
