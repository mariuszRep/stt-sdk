import { describe, expect, it } from "vitest";
import {
  PRIMARY_TASK,
  fromCloudCatalog,
  fromOllama,
  fromSttServerManaged,
  fromSttServerV1Model,
  parseModelRef,
  sttServerManagedState,
  sttServerV1State,
  type CloudModelCatalog,
  type ManagedModel,
  type ModelEntry,
  type OllamaShowResponse,
  type OllamaTagsResponse,
  type ProviderDescriptor,
  type SttServerV1Model,
} from "../src/registry";
import manage from "./fixtures/registry/stt-server-manage.json";
import v1 from "./fixtures/registry/stt-server-v1-models.json";
import tags from "./fixtures/registry/ollama-tags.json";
import shows from "./fixtures/registry/ollama-show.json";
import { entryProblems, stateProblems } from "./registry-schema";

const rows = manage.data as unknown as ManagedModel[];
const v1Rows = v1.data as unknown as SttServerV1Model[];

/** What every entry must satisfy, whatever made it. */
function expectSound(entry: ModelEntry): void {
  expect(entryProblems(entry), entry.ref).toEqual([]);
  expect(parseModelRef(entry.ref), entry.ref).toEqual({ kind: entry.kind, provider: entry.provider, id: entry.id });
  expect(entry.tasks).toContain(PRIMARY_TASK[entry.kind]);
}

describe("fromSttServerManaged", () => {
  const [parakeet, tiny, custom] = rows.map(fromSttServerManaged) as [ModelEntry, ModelEntry, ModelEntry];

  it("turns every fixture row into a schema-valid entry with state", () => {
    for (const row of rows) {
      expectSound(fromSttServerManaged(row));
      expect(stateProblems(sttServerManagedState(row))).toEqual([]);
    }
  });

  it("describes a catalog model that is not downloaded", () => {
    expect(parakeet).toMatchObject({
      ref: "speech/stt-server/parakeet-unified-en-0.6b",
      kind: "speech",
      provider: "stt-server",
      id: "parakeet-unified-en-0.6b",
      name: "Parakeet Unified EN 0.6B",
      tasks: ["speech-to-text"],
      locality: "local",
      access: "free",
      privacy: { sends: [] },
      family: "parakeet",
      architecture: "parakeet",
      license: "cc-by-4.0",
      languages: ["en"],
      editorial: { recommended: true, recommendedRank: 1, speedScore: 79, accuracyScore: 90, source: "handy" },
    });
    expect(parakeet.local).toMatchObject({
      revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
      upstreamId: "handy-computer/parakeet-unified-en-0.6b-gguf",
      defaultQuant: "Q8_0",
      sizeBytes: 731357568,
    });
    expect(parakeet.local?.files).toHaveLength(6);
    expect(parakeet.local?.files?.[0]).toEqual({
      filename: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
      quant: "Q4_K_M",
      sizeBytes: 477274496,
      sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
    });
    expect(parakeet.capabilities.streaming).toMatchObject({ status: "unknown", model_claim: true });
    expect(parakeet.capabilities.prompt).toMatchObject({ status: "unsupported", reason: "model_lacks" });
    expect(parakeet.capabilities.response_formats?.status).toBe("supported");
  });

  it("reads the state of a downloaded default and of a drop-in that needs verification", () => {
    expect(sttServerManagedState(rows[0]!)).toEqual({ ref: parakeet.ref, installed: false, default: false, installedQuant: null });
    expect(sttServerManagedState(rows[1]!)).toEqual({ ref: tiny.ref, installed: true, needsVerification: false, default: true, installedQuant: "Q8_0" });
    expect(sttServerManagedState(rows[2]!)).toEqual({ ref: custom.ref, installed: true, needsVerification: true, default: false, installedQuant: "Q5_K_M" });
    expect(tiny.editorial).toMatchObject({ recommended: false, speedScore: 100 });
    expect(tiny.local?.source).toBe("catalog_download");
  });

  it("keeps a drop-in's id, source and header facts, and has no catalog extras", () => {
    expect(custom).toMatchObject({
      ref: "speech/stt-server/custom-moonshine-tiny-ab12cd34",
      id: "custom-moonshine-tiny-ab12cd34",
      name: "My Moonshine Tiny Q5",
      architecture: "moonshine",
      languages: ["en"],
      local: { source: "user_folder", custom: true },
    });
    expect(custom.editorial).toBeUndefined();
    expect(JSON.stringify(custom)).not.toContain("file_path");
    expect(JSON.stringify(custom)).not.toContain("someone");
  });

  it("carries the catalog fields the server starts serving (description, parameters, base model)", () => {
    const entry = fromSttServerManaged({ ...rows[0]!, description: "Fast, accurate live English transcription", parameters: "0.6B", base_model: "nvidia/parakeet-unified-en-0.6b" });
    expect(entry).toMatchObject({ description: "Fast, accurate live English transcription", parameters: "0.6B", baseModel: "nvidia/parakeet-unified-en-0.6b" });
    expectSound(entry);
  });

  it("leaves out fields its source did not have", () => {
    const entry = fromSttServerManaged({ id: "tiny", name: "tiny", downloaded: true, default: false });
    expect(entry).toEqual({
      ref: "speech/stt-server/tiny",
      kind: "speech",
      provider: "stt-server",
      id: "tiny",
      name: "tiny",
      tasks: ["speech-to-text"],
      locality: "local",
      access: "free",
      privacy: { sends: [] },
      capabilities: {},
    });
    expectSound(entry);
  });
});

describe("fromSttServerV1Model", () => {
  const [tiny, parakeet] = v1Rows.map(fromSttServerV1Model) as [ModelEntry, ModelEntry];

  it("turns every fixture entry into a schema-valid entry; a callable model is installed", () => {
    for (const row of v1Rows) {
      expectSound(fromSttServerV1Model(row));
      expect(stateProblems(sttServerV1State(row))).toEqual([]);
    }
    expect(sttServerV1State(v1Rows[0]!)).toEqual({ ref: tiny.ref, installed: true, default: true });
    expect(sttServerV1State(v1Rows[1]!)).toEqual({ ref: parakeet.ref, installed: true, default: false });
  });

  it("keeps the live matrix of a loaded model and its engine architecture", () => {
    expect(tiny).toMatchObject({ ref: "speech/stt-server/whisper-tiny.en", name: "Whisper Tiny (English)", architecture: "whisper", languages: ["en"] });
    expect(tiny.capabilities.prompt).toMatchObject({ status: "supported", evidence: "loaded_model", max_tokens: 224 });
    expect(tiny.capabilities.timestamp_granularity).toMatchObject({ status: "supported", max: "segment" });
    expect(tiny.capabilities.response_formats?.status).toBe("supported");
    expect(tiny.capabilities.arch).toBeUndefined();
  });

  it("shows the catalog view of a model never loaded", () => {
    expect(parakeet.capabilities.streaming).toMatchObject({ status: "unknown", evidence: "catalog_claim", model_claim: true });
    expect(parakeet.languages).toEqual(["en"]);
  });

  it("lets the top-level language_detect decide, as SttServerProvider does", () => {
    const entry = fromSttServerV1Model({ id: "m", capabilities: { language_detect: { status: "unknown", model_claim: true } }, language_detect: true });
    expect(entry.capabilities.language_detect).toMatchObject({ status: "supported", model_claim: true });
    expect(entry.name).toBe("m");
  });
});

describe("fromOllama", () => {
  const entries = fromOllama(tags as OllamaTagsResponse, shows as Record<string, OllamaShowResponse>);
  const byRef = (ref: string) => entries.find((e) => e.ref === ref)!;

  it("lists every installed model, in Ollama's order, as a schema-valid local entry", () => {
    expect(entries.map((e) => e.ref)).toEqual([
      "llm/ollama/llama3.2:latest",
      "llm/ollama/gemma3:4b",
      "llm/ollama/qwen3:8b",
      "embedding/ollama/nomic-embed-text:latest",
      "llm/ollama/hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M",
    ]);
    for (const entry of entries) {
      expectSound(entry);
      expect(entry).toMatchObject({ provider: "ollama", locality: "local", access: "free", privacy: { sends: [] } });
    }
  });

  it("describes a model from its tags and its show", () => {
    expect(byRef("llm/ollama/llama3.2:latest")).toMatchObject({
      name: "llama3.2:latest",
      tasks: ["text-to-text"],
      family: "llama",
      architecture: "llama",
      parameters: "3.2B",
      local: { sizeBytes: 2019393189, quant: "Q4_K_M", digest: "a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72" },
    });
    expect(byRef("llm/ollama/llama3.2:latest").capabilities).toEqual({
      tools: { status: "supported", evidence: "provider_api" },
      thinking: { status: "unsupported", evidence: "provider_api" },
      vision: { status: "unsupported", evidence: "provider_api" },
      context_window: { status: "supported", evidence: "provider_api", extra: { tokens: 131072 } },
    });
  });

  it("flags what the model does: several tasks for a vision model, embedding for an embedder", () => {
    expect(byRef("llm/ollama/gemma3:4b").tasks).toEqual(["text-to-text", "vision"]);
    expect(byRef("llm/ollama/gemma3:4b").capabilities.vision?.status).toBe("supported");
    expect(byRef("llm/ollama/qwen3:8b").capabilities.thinking?.status).toBe("supported");
    expect(byRef("llm/ollama/qwen3:8b").capabilities.context_window?.extra).toEqual({ tokens: 40960 });
    expect(byRef("embedding/ollama/nomic-embed-text:latest")).toMatchObject({ kind: "embedding", tasks: ["text-embedding"] });
  });

  it("says unknown, not unsupported, for a model whose show is missing", () => {
    const entry = byRef("llm/ollama/hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M");
    expect(entry.capabilities).toEqual({ tools: { status: "unknown" }, thinking: { status: "unknown" }, vision: { status: "unknown" } });
    expect(entry.tasks).toEqual(["text-to-text"]);
    expect(entry.id).toBe("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M");
  });

  it("matches a show given under a name without the tag, and canonicalises a listed name without one", () => {
    const [entry] = fromOllama({ models: [{ name: "llama3.2" }] }, { "llama3.2": shows["llama3.2:latest"] as OllamaShowResponse });
    expect(entry?.ref).toBe("llm/ollama/llama3.2:latest");
    expect(entry?.capabilities.tools?.status).toBe("supported");
    const [other] = fromOllama({ models: [{ name: "llama3.2:latest" }] }, { llama3: { capabilities: ["completion"] } });
    expect(other?.capabilities.tools?.status).toBe("unknown");
  });

  it("reads an older Ollama's show: vision from a projector, tools from the template", () => {
    const [entry] = fromOllama(
      { models: [{ name: "llava:7b" }] },
      { "llava:7b": { projector_info: { "clip.has_vision_encoder": true }, template: "{{ if .Tools }}x{{ end }}", model_info: { "llama.context_length": 4096 } } },
    );
    expect(entry?.tasks).toEqual(["text-to-text", "vision"]);
    expect(entry?.capabilities).toMatchObject({ tools: { status: "supported" }, vision: { status: "supported" }, thinking: { status: "unsupported" }, context_window: { extra: { tokens: 4096 } } });
    expect(entry && entryProblems(entry)).toEqual([]);
  });

  it("is empty for an Ollama with no models", () => {
    expect(fromOllama({})).toEqual([]);
    expect(fromOllama({ models: [] })).toEqual([]);
  });
});

describe("fromCloudCatalog", () => {
  const providers: ProviderDescriptor[] = [
    {
      id: "acme",
      name: "Acme",
      locality: "cloud",
      access: "plus",
      auth: { type: "bearer", keyUrl: "https://acme.example/keys" },
      serves: [
        { kind: "llm", api: "openai-chat", baseUrl: "https://api.acme.example/v1", baseUrlEditable: false, modelsEndpoint: "/models", modelIdFreeText: true, privacy: { sends: ["text", "context"], to: "api.acme.example" } },
        { kind: "speech", api: "openai-audio", baseUrl: "https://api.acme.example/v1", baseUrlEditable: false, modelsEndpoint: null, modelIdFreeText: false, privacy: { sends: ["audio"], to: "api.acme.example" } },
      ],
    },
  ];
  const catalog: CloudModelCatalog = {
    schemaVersion: 1,
    catalogVersion: "2026-10-30",
    models: [
      { provider: "acme", kind: "llm", id: "acme/chat-1", name: "Chat 1", tasks: ["vision"], contextWindow: 128000, claims: { tools: true, thinking: false, jsonSchema: true }, pricingNote: "per token" },
      { provider: "acme", kind: "speech", id: "listen-1", name: "Listen 1", claims: { languageHint: true, streaming: false }, languages: ["en", "de"] },
    ],
  };
  const [chat, listen] = fromCloudCatalog(catalog, providers) as [ModelEntry, ModelEntry];

  it("makes schema-valid cloud entries, plus-only, with what leaves the computer", () => {
    expectSound(chat);
    expectSound(listen);
    expect(chat).toMatchObject({ ref: "llm/acme/acme/chat-1", locality: "cloud", access: "plus", privacy: { sends: ["text", "context", "images"], to: "api.acme.example" } });
    expect(listen).toMatchObject({ ref: "speech/acme/listen-1", locality: "cloud", access: "plus", privacy: { sends: ["audio"], to: "api.acme.example" }, languages: ["en", "de"] });
  });

  it("flags several tasks and turns claims into cloud_claim capabilities", () => {
    expect(chat.tasks).toEqual(["text-to-text", "vision"]);
    expect(chat.capabilities).toEqual({
      tools: { status: "supported", evidence: "cloud_claim" },
      thinking: { status: "unsupported", evidence: "cloud_claim" },
      json_schema: { status: "supported", evidence: "cloud_claim" },
      vision: { status: "supported", evidence: "cloud_claim" },
      context_window: { status: "supported", evidence: "cloud_claim", extra: { tokens: 128000 } },
    });
    expect(listen.capabilities).toEqual({ language_hint: { status: "supported", evidence: "cloud_claim" }, streaming: { status: "unsupported", evidence: "cloud_claim" } });
    expect(chat.cloud).toEqual({ modelIdFreeText: true, pricingNote: "per token" });
    expect(listen.cloud).toEqual({ modelIdFreeText: false });
  });

  it("refuses a model of an unknown provider or of a kind the provider does not serve", () => {
    expect(() => fromCloudCatalog({ ...catalog, models: [{ provider: "nobody", kind: "llm", id: "x", name: "X" }] }, providers)).toThrow(/Unknown provider "nobody"/);
    expect(() => fromCloudCatalog({ ...catalog, models: [{ provider: "acme", kind: "tts", id: "x", name: "X" }] }, providers)).toThrow(/does not serve tts/);
  });
});
