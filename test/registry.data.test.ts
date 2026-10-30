import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS, KNOWN_CLOUD_MODELS, listCloudEntries, parseModelRef } from "../src/registry";
import { cloudCatalogProblems, entryProblems, providerCatalogProblems } from "./registry-schema";
import cloudModelsJson from "../src/registry/data/cloud-models.json";
import providersJson from "../src/registry/data/providers.json";

const LLM_APIS = ["openai-chat", "anthropic-messages", "ollama"];
const SPEECH_APIS = ["openai-audio", "deepgram-listen", "stt-server"];
const providers = BUILTIN_PROVIDERS.providers;
const byId = new Map(providers.map((p) => [p.id, p]));

describe("providers.json", () => {
  it("is valid against the schema and is what the SDK exports", () => {
    expect(providerCatalogProblems(providersJson)).toEqual([]);
    expect(BUILTIN_PROVIDERS).toEqual(providersJson);
  });

  it("has the first set of providers, with Ollama as the local AI and no LM Studio", () => {
    expect(providers.map((p) => p.id)).toEqual(["ollama", "openai", "anthropic", "gemini", "groq", "openrouter", "deepgram", "custom"]);
    expect(providers.filter((p) => p.serves.some((s) => s.kind === "llm")).map((p) => p.id)).toEqual(["ollama", "openai", "anthropic", "gemini", "groq", "openrouter", "custom"]);
    expect(providers.filter((p) => p.serves.some((s) => s.kind === "speech")).map((p) => p.id)).toEqual(["openai", "groq", "deepgram"]);
    expect(JSON.stringify(providersJson).toLowerCase()).not.toContain("lm-studio");
    expect(JSON.stringify(providersJson).toLowerCase()).not.toContain("lmstudio");
  });

  it("keeps local free and sending nothing, and every cloud provider plus, over https, naming where data goes", () => {
    for (const p of providers) {
      if (p.locality === "local") {
        expect(p.access, p.id).toBe("free");
        for (const s of p.serves) expect(s.privacy.sends, p.id).toEqual([]);
        continue;
      }
      expect(p.access, p.id).toBe("plus");
      for (const s of p.serves) {
        expect(s.privacy.sends.length, p.id).toBeGreaterThan(0);
        if (p.template) {
          expect(s.baseUrlEditable, p.id).toBe(true);
          continue;
        }
        expect(s.baseUrl, p.id).toMatch(/^https:\/\//);
        expect(s.baseUrl, p.id).toContain(s.privacy.to);
        expect(p.auth.keyUrl, p.id).toMatch(/^https:\/\//);
        expect(s.baseUrlEditable, p.id).toBe(false);
      }
    }
  });

  it("pairs each kind with a protocol that serves it, one service per kind, and has one key scheme per provider", () => {
    for (const p of providers) {
      const kinds = p.serves.map((s) => s.kind);
      expect(new Set(kinds).size, p.id).toBe(kinds.length);
      for (const s of p.serves) {
        expect(s.kind === "llm" ? LLM_APIS : SPEECH_APIS, `${p.id} ${s.kind}`).toContain(s.api);
        if (s.kind === "llm") expect(s.quirks, `${p.id} llm`).toBeDefined();
        if (s.kind === "llm" && p.locality === "cloud") expect(s.timeouts?.longRunMs, p.id).toBe(180000);
      }
    }
    expect(byId.get("anthropic")?.auth.type).toBe("x-api-key");
    expect(byId.get("deepgram")?.auth.type).toBe("token");
    expect(byId.get("gemini")?.serves[0]?.quirks?.stripModelsPrefix).toBe(true);
  });

  it("holds no secret", () => {
    expect(JSON.stringify(providersJson)).not.toMatch(/sk-[A-Za-z0-9]|AIza|Bearer \S|api[_-]?key["']?\s*:\s*["'][^"']/i);
  });
});

describe("cloud-models.json", () => {
  it("is valid against the schema and is what the SDK exports", () => {
    expect(cloudCatalogProblems(cloudModelsJson)).toEqual([]);
    expect(KNOWN_CLOUD_MODELS).toEqual(cloudModelsJson);
  });

  it("lists models only of providers that serve their kind, each once", () => {
    const seen = new Set<string>();
    for (const m of KNOWN_CLOUD_MODELS.models) {
      const provider = byId.get(m.provider);
      expect(provider, m.id).toBeDefined();
      expect(provider?.locality, m.id).toBe("cloud");
      expect(provider?.template, m.id).toBeUndefined();
      expect(provider?.serves.map((s) => s.kind), m.id).toContain(m.kind);
      const key = `${m.kind}/${m.provider}/${m.id}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("covers every cloud provider of the first set", () => {
    const covered = new Set(KNOWN_CLOUD_MODELS.models.map((m) => `${m.provider}:${m.kind}`));
    for (const key of ["openai:llm", "anthropic:llm", "gemini:llm", "groq:llm", "openrouter:llm", "openai:speech", "groq:speech", "deepgram:speech"]) {
      expect(covered.has(key), key).toBe(true);
    }
  });
});

describe("listCloudEntries", () => {
  const entries = listCloudEntries();

  it("makes a schema-valid, plus-only cloud entry for every known model, with unique references", () => {
    expect(entries).toHaveLength(KNOWN_CLOUD_MODELS.models.length);
    for (const entry of entries) {
      expect(entryProblems(entry), entry.ref).toEqual([]);
      expect(entry).toMatchObject({ locality: "cloud", access: "plus" });
      expect(parseModelRef(entry.ref)).toEqual({ kind: entry.kind, provider: entry.provider, id: entry.id });
    }
    expect(new Set(entries.map((e) => e.ref)).size).toBe(entries.length);
  });

  it("says what leaves the computer: audio for speech, text and context for AI, pictures for a vision model", () => {
    const find = (ref: string) => entries.find((e) => e.ref === ref)!;
    expect(find("speech/deepgram/nova-3").privacy).toEqual({ sends: ["audio"], to: "api.deepgram.com" });
    expect(find("llm/anthropic/claude-haiku-5-5").privacy).toEqual({ sends: ["text", "context", "images"], to: "api.anthropic.com" });
    expect(find("llm/groq/llama-3.3-70b-versatile").privacy).toEqual({ sends: ["text", "context"], to: "api.groq.com" });
    expect(find("llm/groq/llama-3.3-70b-versatile").tasks).toEqual(["text-to-text"]);
    expect(find("llm/openai/gpt-6.1-terra").tasks).toEqual(["text-to-text", "vision"]);
    expect(find("llm/gemini/gemini-3.8-flash").capabilities.context_window?.extra).toEqual({ tokens: 1048576 });
  });

  it("keeps a model id with a slash whole in its reference", () => {
    expect(entries.map((e) => e.ref)).toContain("llm/openrouter/anthropic/claude-sonnet-5.5");
    expect(entries.map((e) => e.ref)).toContain("llm/groq/openai/gpt-oss-20b");
  });
});
