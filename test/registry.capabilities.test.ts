import { describe, expect, it } from "vitest";
import { SttServerProvider } from "../src/providers/stt-server";
import {
  CAPABILITY_CONTROLS,
  MODEL_KINDS,
  MODEL_TASKS,
  PRIMARY_TASK,
  fromSttServerV1Model,
  languagesOfMatrix,
  normalizeMatrix,
  toBooleans,
  type SttServerV1Model,
} from "../src/registry";
import v1Models from "./fixtures/registry/stt-server-v1-models.json";

const HEALTH = { status: "ok", service: "stt-server", version: "0.3.6", api_level: 1 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const rows = v1Models.data as unknown as SttServerV1Model[];

describe("toBooleans", () => {
  it("equals what SttServerProvider.listModels derives, for live and catalog matrices", async () => {
    const provider = new SttServerProvider({
      baseUrl: "http://127.0.0.1:54321",
      token: "t",
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => (String(input).endsWith("/health") ? json(HEALTH) : json(v1Models))) as typeof fetch,
    });
    const listed = await provider.listModels();
    expect(listed).toHaveLength(rows.length);
    for (const model of rows) {
      const entry = fromSttServerV1Model(model);
      const expected = listed.find((m) => m.id === model.id);
      expect(toBooleans(entry.capabilities)).toEqual(expected?.capabilities);
      expect(entry.languages).toEqual(expected?.languages);
    }
  });

  it("treats unknown as not supported, except a claimed translation or streaming", () => {
    const booleans = toBooleans({
      prompt: { status: "unknown" },
      temperature: { status: "unsupported" },
      language_detect: { status: "unknown", model_claim: true },
      translation: { status: "unknown", model_claim: true, target_languages: null },
      streaming: { status: "unknown", model_claim: true },
      timestamp_granularity: { status: "supported" },
    });
    expect(booleans).toEqual({
      prompt: false,
      languageHint: false,
      languageDetect: false,
      translation: true,
      streaming: true,
      temperature: false,
      timestamps: { segment: true, word: false },
    });
  });

  it("offers translation targets only for a translating model that lists some", () => {
    expect(toBooleans({ translation: { status: "supported", target_languages: ["en", "de"] } }).translationTargets).toEqual(["en", "de"]);
    expect(toBooleans({ translation: { status: "supported", target_languages: [] } }).translationTargets).toBeUndefined();
    expect(toBooleans({ translation: { status: "unsupported", target_languages: ["en"] } }).translationTargets).toBeUndefined();
  });

  it("says nothing is supported for no matrix, and a language hint when the catalog claims languages", () => {
    expect(toBooleans(undefined)).toMatchObject({ prompt: false, translation: false, streaming: false, languageHint: false });
    expect(toBooleans({ language_hint: { status: "unknown", model_claim: ["en", "de"] } }).languageHint).toBe(true);
  });
});

describe("matrix helpers", () => {
  it("reads the languages from the flattened control, the catalog claim, or under extra", () => {
    expect(languagesOfMatrix({ language_hint: { status: "supported", languages: ["en"] } })).toEqual(["en"]);
    expect(languagesOfMatrix({ language_hint: { status: "unknown", model_claim: ["en", "pl"] } })).toEqual(["en", "pl"]);
    expect(languagesOfMatrix({ language_hint: { status: "supported", extra: { languages: ["de"] } } })).toEqual(["de"]);
    expect(languagesOfMatrix({})).toBeUndefined();
  });

  it("gives response_formats a status and drops engine facts that are not controls", () => {
    const matrix = normalizeMatrix({
      response_formats: { json: "supported", srt: "unknown" },
      arch: "whisper",
      whisper_ext_accepted: null,
      feature_initial_prompt_flag: true,
      streaming: { status: "unsupported" },
    });
    expect(matrix).toEqual({
      response_formats: { status: "supported", extra: { values: { json: "supported", srt: "unknown" } } },
      streaming: { status: "unsupported" },
    });
    expect(normalizeMatrix({ response_formats: { srt: "unknown", vtt: "unsupported" } }).response_formats?.status).toBe("unknown");
  });
});

describe("vocabulary", () => {
  it("has one task for every kind, all in the task list", () => {
    expect(Object.keys(PRIMARY_TASK).sort()).toEqual([...MODEL_KINDS].sort());
    for (const task of Object.values(PRIMARY_TASK)) expect(MODEL_TASKS).toContain(task);
  });

  it("lists each control once", () => {
    expect(new Set(CAPABILITY_CONTROLS).size).toBe(CAPABILITY_CONTROLS.length);
  });
});
