import type { ModelPrivacy } from "../types";

/** The object without its `undefined` fields, so an entry carries only what its source said. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** A model that runs on this computer sends nothing anywhere. */
export const localPrivacy = (): ModelPrivacy => ({ sends: [] });
