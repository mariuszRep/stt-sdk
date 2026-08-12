import { describe, it, expect, vi } from "vitest";
import { FasterWhisperProvider } from "../src/providers/faster-whisper";
import { ApiError, ConnectionError } from "../src/errors";
import configFixture from "./fixtures/faster-whisper-config.json";
import batchFixture from "./fixtures/faster-whisper-batch-response.json";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Capture {
  url: string;
  init?: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];

function mockFetch(captures: Capture[], handler?: (init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: FetchInput, init?: RequestInit) => {
    captures.push({ url: String(input), init });
    return handler ? handler(init!) : jsonResponse(batchFixture);
  }) as unknown as typeof fetch;
}

describe("FasterWhisperProvider — batch contract (preserved from App api.ts)", () => {
  it("POSTs multipart `file` to /v1/audio/transcriptions and returns { text }", async () => {
    const captures: Capture[] = [];
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch(captures),
    });

    const result = await provider.transcribe({ file: new Uint8Array([1, 2, 3]) });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(captures[0]!.init?.method).toBe("POST");

    const form = captures[0]!.init!.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.webm"); // default filename preserved
    expect(form.get("prompt")).toBeNull(); // no prompt by default

    expect(result).toEqual({ text: "hello world from the faster whisper runtime" });
  });

  it("appends a trimmed prompt and keeps the provided filename", async () => {
    const captures: Capture[] = [];
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch(captures),
    });

    await provider.transcribe({
      file: new Blob([new Uint8Array([4, 5, 6])]),
      filename: "recording.webm",
      prompt: "  previous line + context  ",
    });

    const form = captures[0]!.init!.body as FormData;
    expect(form.get("prompt")).toBe("previous line + context");
    expect((form.get("file") as File).name).toBe("recording.webm");
  });

  it("throws ApiError with status on non-ok responses", async () => {
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch([], () => jsonResponse({ detail: "boom" }, 500)),
    });

    await expect(provider.transcribe({ file: new Uint8Array([1]) })).rejects.toMatchObject({
      name: "ApiError",
      code: "transcription_failed",
      status: 500,
    });
  });

  it("throws ConnectionError when the network fails", async () => {
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    await expect(provider.transcribe({ file: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  it("passes the abort signal through", async () => {
    const captures: Capture[] = [];
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch(captures),
    });
    const controller = new AbortController();

    await provider.transcribe({ file: new Uint8Array([1]), signal: controller.signal });

    expect(captures[0]!.init?.signal).toBe(controller.signal);
  });
});

describe("FasterWhisperProvider — models", () => {
  it("listModels returns the configured model from /v1/config", async () => {
    const captures: Capture[] = [];
    const provider = new FasterWhisperProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch(captures, () => jsonResponse(configFixture)),
    });

    const models = await provider.listModels();

    expect(captures[0]!.url).toBe("http://127.0.0.1:8000/v1/config");
    expect(models).toEqual([{ id: "Systran/faster-whisper-small", name: "Systran/faster-whisper-small" }]);
  });

  it("exposes the expected capability descriptor", () => {
    const provider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
    expect(provider.capability).toMatchObject({
      id: "faster-whisper",
      privacy: "local",
      supportsBatch: true,
      supportsStreaming: true,
      available: true,
    });
  });
});
