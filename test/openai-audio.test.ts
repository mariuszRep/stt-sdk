import { describe, expect, it, vi } from "vitest";
import { ApiError, ConnectionError, GroqProvider, OpenAIProvider, UnsupportedCapabilityError } from "../src";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recording(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAIProvider / GroqProvider — the OpenAI audio API, batch only", () => {
  it("POSTs the recording and the request's settings as multipart to the provider's transcriptions route", async () => {
    const { calls, fetchImpl } = recording({ text: "Hello there." });
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });
    const result = await provider.transcribe({
      file: new Uint8Array([1, 2, 3]),
      filename: "clip.wav",
      model: "whisper-1",
      language: "en",
      prompt: "Stanzo",
      temperature: 0,
    });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const form = calls[0]!.init!.body as FormData;
    expect((form.get("file") as File).name).toBe("clip.wav");
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Stanzo");
    expect(form.get("temperature")).toBe("0");
    expect(form.get("response_format")).toBe("json");
    expect(form.getAll("timestamp_granularities[]")).toEqual([]);
    expect(result).toEqual({ text: "Hello there." });
  });

  it("sends the provider's default model and leaves out what the request does not set", async () => {
    const { calls, fetchImpl } = recording({ text: "" });
    await new GroqProvider({ apiKey: "gsk", fetchImpl }).transcribe({ file: new Uint8Array([1]) });
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    for (const field of ["language", "prompt", "temperature"]) expect(form.has(field)).toBe(false);
  });

  it("asks for word timings only when the request does, and reads the answer as stt-server's: words in their segments", async () => {
    const { calls, fetchImpl } = recording({
      text: "Hello world",
      language: "english",
      duration: 1.25,
      segments: [{ text: "Hello world", start: 0, end: 1.0 }],
      words: [
        { word: "Hello", start: 0, end: 0.5 },
        { word: "world", start: 0.5, end: 1.0 },
      ],
    });
    const result = await new GroqProvider({ apiKey: "gsk", fetchImpl, baseUrl: "http://127.0.0.1:9/openai/v1/" }).transcribe({
      file: new Uint8Array([1]),
      wordTimestamps: true,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/openai/v1/audio/transcriptions");
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
    expect(result.language).toBe("english");
    expect(result.durationMs).toBe(1250);
    expect(result.segments).toHaveLength(1);
    expect(result.segments![0]).toMatchObject({ text: "Hello world", startMs: 0, endMs: 1000 });
    expect(result.segments![0]!.words!.map((w) => [w.word, w.startMs, w.endMs])).toEqual([
      ["Hello", 0, 500],
      ["world", 500, 1000],
    ]);
  });

  it("throws ApiError with the status on a refusal (retryable as the registry's provider data says) and ConnectionError when unreachable", async () => {
    const refused = new OpenAIProvider({ apiKey: "k", fetchImpl: recording({ error: { message: "bad key" } }, 401).fetchImpl });
    await expect(refused.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({ name: "ApiError", status: 401, retryable: false });
    const limited = new OpenAIProvider({ apiKey: "k", fetchImpl: recording({}, 429).fetchImpl });
    await expect(limited.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({ status: 429, retryable: true });
    await expect(limited.transcribe({ file: new Uint8Array([1]) })).rejects.toBeInstanceOf(ApiError);
    const broken = new OpenAIProvider({ apiKey: "k", fetchImpl: recording({}, 500).fetchImpl });
    await expect(broken.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({ status: 500, retryable: false });
    const offline = new OpenAIProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(offline.transcribe({ file: new Uint8Array([1]) })).rejects.toBeInstanceOf(ConnectionError);
  });

  it("names an upload without a filename by its type, and a non-JSON answer is a typed error", async () => {
    const { calls, fetchImpl } = recording({ text: "" });
    await new OpenAIProvider({ apiKey: "k", fetchImpl }).transcribe({ file: new Blob([new Uint8Array([1])], { type: "audio/webm;codecs=opus" }) });
    expect(((calls[0]!.init!.body as FormData).get("file") as File).name).toBe("recording.webm");
    const html = new OpenAIProvider({
      apiKey: "k",
      fetchImpl: vi.fn(async () => new Response("<html>portal</html>", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(html.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({ name: "ApiError", code: "invalid_response" });
  });

  it("gives up after the registry's time for a call when the caller gives no signal", async () => {
    const { calls, fetchImpl } = recording({ text: "" });
    await new OpenAIProvider({ apiKey: "k", fetchImpl }).transcribe({ file: new Uint8Array([1]) });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    const own = new AbortController();
    await new OpenAIProvider({ apiKey: "k", fetchImpl }).transcribe({ file: new Uint8Array([1]), signal: own.signal });
    expect(calls[1]!.init!.signal).toBe(own.signal);
  });

  it("lists the SDK's known speech models of the provider, the default marked, without a call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const openai = await new OpenAIProvider({ apiKey: "k", fetchImpl }).listModels();
    expect(openai.map((m) => m.id)).toEqual(["gpt-transcribe", "whisper-1"]);
    expect(openai.find((m) => m.isDefault)?.id).toBe("gpt-transcribe");
    expect(openai.find((m) => m.id === "whisper-1")?.capabilities?.translation).toBe(true);
    const groq = await new GroqProvider({ apiKey: "k", fetchImpl }).listModels();
    expect(groq.map((m) => m.id)).toEqual(["whisper-large-v3-turbo", "whisper-large-v3"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a batch provider: it reports no streaming and refuses a live stream with a typed error", async () => {
    const provider = new OpenAIProvider({ apiKey: "k" });
    expect(provider.capability).toMatchObject({ available: true, supportsBatch: true, supportsStreaming: false, privacy: "cloud" });
    await expect(provider.createStream({ language: "en", model: "gpt-transcribe", sampleRate: 16000, encoding: "pcm_s16le", channels: 1 })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it("needs a key", () => {
    expect(() => new OpenAIProvider({ apiKey: "" })).toThrow(/apiKey/);
  });
});
