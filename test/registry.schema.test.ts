import { describe, expect, it } from "vitest";
import {
  MODEL_ACCESS,
  MODEL_ENTRY_SCHEMA,
  MODEL_KINDS,
  MODEL_LOCALITIES,
  MODEL_TASKS,
  PRIMARY_TASK,
  PRIVACY_SENDS,
  PROVIDER_APIS,
  PROVIDER_AUTH_TYPES,
  REASONING_OFF_QUIRKS,
  fromSttServerManaged,
  type ManagedModel,
} from "../src/registry";
import manage from "./fixtures/registry/stt-server-manage.json";
import { entryProblems, stateProblems } from "./registry-schema";

const defs = MODEL_ENTRY_SCHEMA.$defs as Record<string, { enum?: unknown[]; properties?: Record<string, { enum?: unknown[] }> }>;

const valid = (): Record<string, unknown> => structuredClone(fromSttServerManaged(manage.data[0] as unknown as ManagedModel)) as unknown as Record<string, unknown>;

describe("model-entry.v1.json", () => {
  it("lists the same words as the TypeScript vocabulary", () => {
    expect(defs.kind?.enum).toEqual([...MODEL_KINDS]);
    expect(defs.task?.enum).toEqual([...MODEL_TASKS]);
    expect(defs.privacy?.properties?.sends).toMatchObject({ items: { enum: [...PRIVACY_SENDS] } });
    const top = MODEL_ENTRY_SCHEMA.properties as Record<string, { enum?: unknown[] }>;
    expect(top.locality?.enum).toEqual([...MODEL_LOCALITIES]);
    expect(top.access?.enum).toEqual([...MODEL_ACCESS]);
    expect(defs.providerAuth?.properties?.type?.enum).toEqual([...PROVIDER_AUTH_TYPES]);
    expect(defs.providerService?.properties?.api?.enum).toEqual([...PROVIDER_APIS]);
    expect(defs.providerQuirks?.properties?.reasoningOff?.enum).toEqual([...REASONING_OFF_QUIRKS]);
  });

  it("requires the task of the entry's kind, for every kind", () => {
    for (const kind of MODEL_KINDS) {
      const entry = { ...valid(), kind, ref: `${kind}/stt-server/x`, id: "x", tasks: [PRIMARY_TASK[kind]] };
      expect(entryProblems(entry), kind).toEqual([]);
      expect(entryProblems({ ...entry, tasks: ["vision"] }), kind).not.toEqual([]);
    }
  });

  it("lets a model carry several tasks", () => {
    expect(entryProblems({ ...valid(), kind: "llm", ref: "llm/stt-server/x", id: "x", tasks: ["text-to-text", "vision"] })).toEqual([]);
    expect(entryProblems({ ...valid(), tasks: [] })).not.toEqual([]);
    expect(entryProblems({ ...valid(), tasks: ["speech-to-text", "speech-to-text"] })).not.toEqual([]);
    expect(entryProblems({ ...valid(), tasks: ["speech-to-text", "juggling"] })).not.toEqual([]);
  });

  it("ties locality to what leaves the computer", () => {
    expect(entryProblems({ ...valid(), privacy: { sends: ["audio"] } })).not.toEqual([]);
    expect(entryProblems({ ...valid(), locality: "cloud", access: "plus", privacy: { sends: [] } })).not.toEqual([]);
    expect(entryProblems({ ...valid(), locality: "cloud", access: "plus", privacy: { sends: ["audio"], to: "api.example.com" } })).toEqual([]);
  });

  it("refuses an entry that is missing a required field or malformed", () => {
    for (const field of ["ref", "kind", "provider", "id", "name", "tasks", "locality", "access", "privacy", "capabilities"]) {
      const entry: Record<string, unknown> = valid();
      delete entry[field];
      expect(entryProblems(entry), field).not.toEqual([]);
    }
    expect(entryProblems({ ...valid(), ref: "whisper-tiny" })).not.toEqual([]);
    expect(entryProblems({ ...valid(), locality: "moon" })).not.toEqual([]);
    expect(entryProblems({ ...valid(), capabilities: { streaming: { status: "maybe" } } })).not.toEqual([]);
    expect(entryProblems({ ...valid(), capabilities: { streaming: {} } })).not.toEqual([]);
    expect(entryProblems({ ...valid(), local: { files: [{ filename: "a.gguf", quant: "Q8_0", sha256: "nothex" }] } })).not.toEqual([]);
  });

  it("accepts fields a later version adds (additive changes never break an older reader)", () => {
    expect(entryProblems({ ...valid(), somethingNew: { a: 1 } })).toEqual([]);
  });

  it("describes the live state of a model", () => {
    expect(stateProblems({ ref: "speech/stt-server/x", installed: true, default: false, needsKey: false, reachable: true })).toEqual([]);
    expect(stateProblems({ ref: "speech/stt-server/x", installed: true })).not.toEqual([]);
  });
});
