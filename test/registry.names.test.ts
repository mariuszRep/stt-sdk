import { describe, expect, it } from "vitest";
import { withUniqueNames } from "../src/registry/names";

// Moved here with the client from the app (`lib/models/model-names.test.ts`); `nameWithoutLanguage` stays in the app.

const model = (id: string, name: string) => ({ id, name });
const names = (models: ReadonlyArray<{ name: string }>) => models.map((m) => m.name);

describe("withUniqueNames", () => {
  it("leaves names that are already unique alone", () => {
    const models = [model("whisper-small", "Whisper Small"), model("whisper-tiny.en", "Whisper Tiny (English)")];
    expect(withUniqueNames(models)).toEqual(models);
  });

  it("tells two models with one name apart by the words only one of them has", () => {
    const catalog = [
      model("cohere-transcribe-03-2026", "Cohere Transcribe"),
      model("whisper-small", "Whisper Small"),
      model("cohere-transcribe-arabic-07-2026", "Cohere Transcribe"),
    ];
    expect(names(withUniqueNames(catalog))).toEqual(["Cohere Transcribe", "Whisper Small", "Cohere Transcribe (Arabic)"]);
    expect(withUniqueNames(catalog).map((m) => m.id)).toEqual(catalog.map((m) => m.id));
  });

  it("uses version numbers when the ids differ only in them", () => {
    expect(names(withUniqueNames([model("acme-asr-03", "Acme ASR"), model("acme-asr-07", "Acme ASR")]))).toEqual(["Acme ASR (03)", "Acme ASR (07)"]);
  });

  it("gives every model with a shared name its own words", () => {
    const renamed = withUniqueNames([model("big-fast", "Big"), model("big-slow", "Big"), model("big-fast-eu", "Big")]);
    expect(new Set(names(renamed)).size).toBe(3);
    expect(names(renamed)).toEqual(["Big (Fast)", "Big (Slow)", "Big (Fast Eu)"]);
  });
});
