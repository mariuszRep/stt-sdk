import { describe, expect, it } from "vitest";
import { canonicalOllamaTag, formatModelRef, ollamaModelRef, parseModelRef, sttServerModelRef } from "../src/registry";

describe("model references", () => {
  it("round-trips kind/provider/id", () => {
    const ref = { kind: "speech", provider: "stt-server", id: "parakeet-tdt-0.6b-v2" } as const;
    expect(formatModelRef(ref)).toBe("speech/stt-server/parakeet-tdt-0.6b-v2");
    expect(parseModelRef("speech/stt-server/parakeet-tdt-0.6b-v2")).toEqual(ref);
  });

  it("keeps a drop-in id (custom-<slug>-<sha8>) and a catalog id with capitals whole", () => {
    expect(sttServerModelRef("custom-moonshine-tiny-ab12cd34")).toBe("speech/stt-server/custom-moonshine-tiny-ab12cd34");
    expect(parseModelRef("speech/stt-server/custom-moonshine-tiny-ab12cd34")?.id).toBe("custom-moonshine-tiny-ab12cd34");
    expect(sttServerModelRef("Voxtral-Mini-4B-Realtime-2602")).toBe("speech/stt-server/Voxtral-Mini-4B-Realtime-2602");
  });

  it("splits only on the first two slashes, so an id may hold / and :", () => {
    const text = "llm/ollama/hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M";
    expect(parseModelRef(text)).toEqual({ kind: "llm", provider: "ollama", id: "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M" });
    expect(formatModelRef(parseModelRef(text)!)).toBe(text);
    expect(parseModelRef("llm/openrouter/anthropic/claude-sonnet-4.5")?.id).toBe("anthropic/claude-sonnet-4.5");
    expect(parseModelRef("llm/groq/openai/gpt-oss-20b")?.id).toBe("openai/gpt-oss-20b");
  });

  it("accepts a custom endpoint provider id with a colon", () => {
    expect(parseModelRef("llm/custom:3/my-model:7b")).toEqual({ kind: "llm", provider: "custom:3", id: "my-model:7b" });
  });

  it("canonicalises an Ollama name without a tag to :latest, in both directions", () => {
    expect(canonicalOllamaTag("llama3.2")).toBe("llama3.2:latest");
    expect(canonicalOllamaTag("llama3.2:latest")).toBe("llama3.2:latest");
    expect(canonicalOllamaTag("gemma3:4b")).toBe("gemma3:4b");
    expect(ollamaModelRef("llama3.2")).toBe("llm/ollama/llama3.2:latest");
    expect(parseModelRef("llm/ollama/llama3.2")?.id).toBe("llama3.2:latest");
    expect(formatModelRef({ kind: "llm", provider: "ollama", id: "qwen3" })).toBe("llm/ollama/qwen3:latest");
  });

  it("reads a registry host's port as part of the name, not as a tag", () => {
    expect(canonicalOllamaTag("localhost:5000/library/llama3.2")).toBe("localhost:5000/library/llama3.2:latest");
    expect(canonicalOllamaTag("localhost:5000/library/llama3.2:3b")).toBe("localhost:5000/library/llama3.2:3b");
    expect(canonicalOllamaTag("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M")).toBe("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M");
    expect(canonicalOllamaTag("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF")).toBe("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:latest");
  });

  it("only Ollama ids are canonicalised", () => {
    expect(parseModelRef("llm/openai/gpt-4o-mini")?.id).toBe("gpt-4o-mini");
    expect(parseModelRef("speech/stt-server/whisper-tiny")?.id).toBe("whisper-tiny");
  });

  it.each([
    "",
    "whisper-tiny",
    "speech/stt-server",
    "speech/stt-server/",
    "speech//whisper-tiny",
    "robot/stt-server/whisper-tiny",
    "Speech/stt-server/whisper-tiny",
    "speech/STT Server/whisper-tiny",
    "speech/stt-server/ whisper-tiny",
    "speech/stt-server/whisper-tiny ",
    "speech/stt-server/whisper\ntiny",
  ])("is not a reference: %j", (text) => {
    expect(parseModelRef(text)).toBeNull();
  });

  it("refuses to format a part that cannot be one", () => {
    expect(() => formatModelRef({ kind: "robot" as never, provider: "x", id: "y" })).toThrow(/kind/);
    expect(() => formatModelRef({ kind: "llm", provider: "a/b", id: "y" })).toThrow(/provider/);
    expect(() => formatModelRef({ kind: "llm", provider: "", id: "y" })).toThrow(/provider/);
    expect(() => formatModelRef({ kind: "llm", provider: "openai", id: "" })).toThrow(/id/);
    expect(() => formatModelRef({ kind: "llm", provider: "ollama", id: "  " })).toThrow(/id/);
  });
});
