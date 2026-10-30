import { describe, expect, it } from "vitest";
import {
  CancelledError,
  ModelManagerError,
  SttServerManagement,
  getModelDisplaySizeBytes,
  isModelBusyError,
  managementToken,
  type ManagedModel,
} from "../src";
import { entryProblems } from "./registry-schema";
import manage from "./fixtures/registry/stt-server-manage.json";
import registry from "./fixtures/registry/stt-server-registry.json";

// These tests moved here with the client from the app (`lib/models/model-manager.test.ts`); the assertions are the same.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const notFound = () => jsonResponse({ error: { code: "not_found", message: "no such route" } }, 404);

/** A server from before `GET /v1/registry`: no such route, `/models/manage` as it always was. */
function olderServer(manageBody: unknown): typeof fetch {
  return (async (url: string) => (String(url).endsWith("/v1/registry") ? notFound() : jsonResponse(manageBody))) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch) {
  return new SttServerManagement({ baseUrl: "http://127.0.0.1:54321", token: "admin-token", fetchImpl });
}

describe("managementToken", () => {
  it("always picks the admin token, ignoring userToken", () => {
    expect(managementToken({ token: "admin-tok", userToken: "user-tok" })).toBe("admin-tok");
    expect(managementToken({ token: "admin-tok", userToken: null })).toBe("admin-tok");
    expect(managementToken({ token: "admin-tok" })).toBe("admin-tok");
  });

  it("throws when no admin token is available yet", () => {
    expect(() => managementToken({ userToken: "user-tok" })).toThrow(/No auth token available/);
    expect(() => managementToken({})).toThrow(/No auth token available/);
  });
});

describe("SttServerManagement", () => {
  it("listManagedModels sends the admin bearer token and parses the array", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = makeClient((async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>).Authorization!;
      return jsonResponse({ object: "list", data: [{ id: "tiny", name: "tiny", downloaded: true, default: true }] });
    }) as unknown as typeof fetch);
    const models = await client.listManagedModels();
    expect(seenUrl).toBe("http://127.0.0.1:54321/models/manage");
    expect(seenAuth).toBe("Bearer admin-token");
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("tiny");
  });

  it("listManagedModels gives two catalog entries that share a name a name each", async () => {
    const client = makeClient((async () =>
      jsonResponse({
        data: [
          { id: "cohere-transcribe-03-2026", name: "Cohere Transcribe", downloaded: false, default: false },
          { id: "cohere-transcribe-arabic-07-2026", name: "Cohere Transcribe", downloaded: false, default: false },
        ],
      })) as unknown as typeof fetch);
    expect((await client.listManagedModels()).map((m) => m.name)).toEqual(["Cohere Transcribe", "Cohere Transcribe (Arabic)"]);
  });

  it("listRegistryEntries asks the server for its registry, with the admin token, and keeps what it answers", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = makeClient((async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>).Authorization!;
      return jsonResponse(registry);
    }) as unknown as typeof fetch);
    const listing = await client.listRegistryEntries();
    expect(seenUrl).toBe("http://127.0.0.1:54321/v1/registry");
    expect(seenAuth).toBe("Bearer admin-token");
    expect(listing.entries.map((e) => e.ref)).toEqual(registry.data.map((e) => e.ref));
    expect(listing.entries.flatMap((e) => entryProblems(e))).toEqual([]);
    expect(listing.states.map((s) => s.ref)).toEqual(listing.entries.map((e) => e.ref));
    expect(listing.catalogVersion).toBe(2);
    expect(listing.generatedAt).toBe("2026-08-17T11:27:14+00:00");
  });

  it("listRegistryEntries includes the models compiled into the server, with the size and hash of their weights", async () => {
    const client = makeClient((async () => jsonResponse(registry)) as unknown as typeof fetch);
    const { entries, states } = await client.listRegistryEntries();
    const builtins = entries.filter((e) => e.builtin);
    expect(builtins.map((e) => [e.kind, e.id])).toEqual([["speaker", "campplus-voxceleb-v1"], ["vad", "silero-v5"]]);
    expect(builtins[1]!.local?.files?.[0]).toEqual({
      filename: "silero_v5_16k.f32",
      quant: "F32",
      sizeBytes: 1238532,
      sha256: "b8df2e6e32753b7aa47ab59571b0d9d0b490a223f8dc9118bb388efeaec6f8e3",
    });
    expect(states.filter((s) => s.ref.startsWith("speaker/") || s.ref.startsWith("vad/")).map((s) => [s.installed, s.default])).toEqual([[true, true], [true, true]]);
  });

  it("listRegistryEntries gives two entries that share a name a name each", async () => {
    const twin = (id: string) => ({ ...registry.data[1]!, ref: `speech/stt-server/${id}`, id, name: "Cohere Transcribe" });
    const client = makeClient((async () =>
      jsonResponse({
        ...registry,
        data: [twin("cohere-transcribe-03-2026"), twin("cohere-transcribe-arabic-07-2026")],
        states: [],
      })) as unknown as typeof fetch);
    expect((await client.listRegistryEntries()).entries.map((e) => e.name)).toEqual(["Cohere Transcribe", "Cohere Transcribe (Arabic)"]);
  });

  it("listRegistryEntries takes the catalog version as the server writes it, a number or a date", async () => {
    const versions = [3, "2026-10-30"];
    for (const version of versions) {
      const client = makeClient((async () => jsonResponse({ ...registry, catalog_version: version })) as unknown as typeof fetch);
      expect((await client.listRegistryEntries()).catalogVersion).toBe(version);
    }
    const bare = makeClient((async () => jsonResponse({ data: [], states: [] })) as unknown as typeof fetch);
    expect(await bare.listRegistryEntries()).toEqual({ entries: [], states: [] });
  });

  it("listRegistryEntries falls back to the adapters on a server with no /v1/registry", async () => {
    const calls: string[] = [];
    const inner = olderServer(manage);
    const client = makeClient((async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      return inner(url, init);
    }) as unknown as typeof fetch);
    const listing = await client.listRegistryEntries();
    expect(calls).toEqual(["http://127.0.0.1:54321/v1/registry", "http://127.0.0.1:54321/models/manage"]);
    expect(listing.entries.map((e) => e.ref)).toEqual([
      "speech/stt-server/parakeet-unified-en-0.6b",
      "speech/stt-server/whisper-tiny.en",
      "speech/stt-server/custom-moonshine-tiny-ab12cd34",
    ]);
    expect(listing.entries.flatMap((e) => entryProblems(e))).toEqual([]);
    expect(listing.states.map((s) => s.ref)).toEqual(listing.entries.map((e) => e.ref));
    expect(listing.states.map((s) => [s.installed, s.default])).toEqual([[false, false], [true, true], [true, false]]);
    expect(listing.catalogVersion).toBeUndefined();
  });

  it("listRegistryEntries fallback gives two catalog entries that share a name a name each", async () => {
    const client = makeClient(
      olderServer({
        data: [
          { id: "cohere-transcribe-03-2026", name: "Cohere Transcribe", downloaded: false, default: false },
          { id: "cohere-transcribe-arabic-07-2026", name: "Cohere Transcribe", downloaded: false, default: false },
        ],
      }),
    );
    expect((await client.listRegistryEntries()).entries.map((e) => e.name)).toEqual(["Cohere Transcribe", "Cohere Transcribe (Arabic)"]);
  });

  it("listRegistryEntries does not hide a failure other than a missing route", async () => {
    const broken = makeClient((async () => jsonResponse({ error: { code: "internal_error", message: "boom" } }, 500)) as unknown as typeof fetch);
    await expect(broken.listRegistryEntries()).rejects.toMatchObject({ code: "internal_error", status: 500 });
    const denied = makeClient((async () => jsonResponse({ error: { code: "invalid_token", message: "no" } }, 401)) as unknown as typeof fetch);
    await expect(denied.listRegistryEntries()).rejects.toMatchObject({ status: 401 });
    const gone = makeClient((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(gone.listRegistryEntries()).rejects.toMatchObject({ code: "connection_error" });
  });

  it("getHealth sends no Authorization header", async () => {
    let seenHeaders: Record<string, string> = {};
    const client = makeClient((async (_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse({ status: "ok", service: "stt-server", api_level: 1 });
    }) as unknown as typeof fetch);
    const health = await client.getHealth();
    expect(health.status).toBe("ok");
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  it("downloadModel and getOperation hit the right paths", async () => {
    const calls: string[] = [];
    const client = makeClient((async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/download")) return jsonResponse({ operation_id: "op1", state: "queued" }, 202);
      return jsonResponse({ operation_id: "op1", state: "completed" });
    }) as unknown as typeof fetch);
    const started = await client.downloadModel("tiny");
    expect(started.operation_id).toBe("op1");
    const state = await client.getOperation("op1");
    expect(state.state).toBe("completed");
    expect(calls).toEqual([
      "http://127.0.0.1:54321/models/manage/tiny/download",
      "http://127.0.0.1:54321/models/manage/operations/op1",
    ]);
  });

  it("pollOperation resolves once the operation completes", async () => {
    let call = 0;
    const client = makeClient((async () => {
      call += 1;
      if (call < 3) return jsonResponse({ operation_id: "op1", state: "running", progress_bytes: call * 10 });
      return jsonResponse({ operation_id: "op1", state: "completed" });
    }) as unknown as typeof fetch);
    const progressed: number[] = [];
    const result = await client.pollOperation("op1", {
      intervalMs: 1,
      onProgress: (s) => progressed.push(s.progress_bytes ?? 0),
    });
    expect(result.state).toBe("completed");
    expect(progressed).toHaveLength(3);
  });

  it("pollOperation throws CancelledError when the operation is cancelled", async () => {
    const client = makeClient((async () => jsonResponse({ operation_id: "op1", state: "cancelled" })) as unknown as typeof fetch);
    await expect(client.pollOperation("op1", { intervalMs: 1 })).rejects.toBeInstanceOf(CancelledError);
  });

  it("pollOperation throws with the server's message when the operation fails", async () => {
    const client = makeClient((async () =>
      jsonResponse({ operation_id: "op1", state: "failed", error: "hash mismatch" })) as unknown as typeof fetch);
    await expect(client.pollOperation("op1", { intervalMs: 1 })).rejects.toThrow(/hash mismatch/);
  });

  it("a non-ok response is parsed into a ModelManagerError with the server's code", async () => {
    const client = makeClient((async () =>
      jsonResponse({ error: { code: "model_not_installed", message: "no such model" } }, 404)) as unknown as typeof fetch);
    const err = await client.setDefaultModel("nope").catch((e) => e);
    expect(err).toBeInstanceOf(ModelManagerError);
    expect(err.code).toBe("model_not_installed");
    expect(err.status).toBe(404);
    expect(err.message).toBe("no such model");
  });

  it("a fetch-level failure is wrapped as a connection_error", async () => {
    const client = makeClient((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const err = await client.getSystemInfo().catch((e) => e);
    expect(err).toBeInstanceOf(ModelManagerError);
    expect(err.code).toBe("connection_error");
  });

  it("patchConfig sends a PATCH with a JSON body", async () => {
    let seenMethod = "";
    let seenBody = "";
    const client = makeClient((async (_url: string, init?: RequestInit) => {
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body ?? "");
      return jsonResponse({ network_mode: "lan" });
    }) as unknown as typeof fetch);
    const result = await client.patchConfig({ network_mode: "lan" });
    expect(seenMethod).toBe("PATCH");
    expect(seenBody).toBe(JSON.stringify({ network_mode: "lan" }));
    expect(result.network_mode).toBe("lan");
  });

  it("getReadiness returns the parsed body even on a 503", async () => {
    const client = makeClient((async () =>
      jsonResponse({ status: "not_ready", reason: "loading model", model: "tiny" }, 503)) as unknown as typeof fetch);
    const readiness = await client.getReadiness();
    expect(readiness.status).toBe("not_ready");
    expect(readiness.reason).toBe("loading model");
  });
});

describe("SttServerManagement.setDefaultModelWhenIdle", () => {
  const busy = () => jsonResponse({ error: { code: "model_loading", message: "Another model is still loading" } }, 409);

  it("waits while the server is loading, then sets the default", async () => {
    let selects = 0;
    let waits = 0;
    const client = makeClient((async (url: string) => {
      if (String(url).endsWith("/readiness")) return jsonResponse({ status: "not_ready", loaded_model: null }, 503);
      selects += 1;
      return selects < 3 ? busy() : jsonResponse({ model: "m", backend: {} });
    }) as unknown as typeof fetch);
    const result = await client.setDefaultModelWhenIdle("m", { onWaiting: () => (waits += 1) });
    expect(result.model).toBe("m");
    expect(selects).toBe(3);
    expect(waits).toBe(2);
  });

  it("is done as soon as readiness reports the model loaded", async () => {
    let selects = 0;
    const client = makeClient((async (url: string) => {
      if (String(url).endsWith("/readiness")) return jsonResponse({ status: "ready", loaded_model: "m" });
      selects += 1;
      return busy();
    }) as unknown as typeof fetch);
    const result = await client.setDefaultModelWhenIdle("m");
    expect(result.model).toBe("m");
    expect(selects).toBe(1);
  });

  it("fails at once on a real failure, and after the wait when the server stays busy", async () => {
    const invalid = makeClient((async () => jsonResponse({ error: { code: "model_load_failed", message: "bad model" } }, 409)) as unknown as typeof fetch);
    await expect(invalid.setDefaultModelWhenIdle("m")).rejects.toThrow(/bad model/);
    const gone = makeClient((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(gone.setDefaultModelWhenIdle("m")).rejects.toThrow(/Failed to reach/);
    const stuck = makeClient((async (url: string) =>
      String(url).endsWith("/readiness") ? jsonResponse({ status: "not_ready" }, 503) : busy()) as unknown as typeof fetch);
    await expect(stuck.setDefaultModelWhenIdle("m", { waitMs: 0 })).rejects.toThrow(/still busy loading/);
  });

  it("stops waiting when cancelled", async () => {
    const controller = new AbortController();
    const client = makeClient((async (url: string) =>
      String(url).endsWith("/readiness") ? jsonResponse({ status: "not_ready" }, 503) : busy()) as unknown as typeof fetch);
    const pending = client.setDefaultModelWhenIdle("m", { signal: controller.signal, onWaiting: () => controller.abort() });
    await expect(pending).rejects.toSatisfy((err: Error) => err.name === "AbortError");
  });

  it("only a model that is loading or a stream in progress is a busy refusal", () => {
    expect(isModelBusyError(new ModelManagerError("x", "model_loading", 409))).toBe(true);
    expect(isModelBusyError(new ModelManagerError("x", "engine_busy", 503))).toBe(true);
    expect(isModelBusyError(new ModelManagerError("x", "model_load_failed", 409))).toBe(false);
    expect(isModelBusyError(new Error("x"))).toBe(false);
  });
});

describe("getModelDisplaySizeBytes", () => {
  const model = (extra: Partial<ManagedModel>): ManagedModel => ({ id: "m", name: "m", downloaded: false, default: false, ...extra });

  it("prefers the model's own size, then the default quant's file, then the first file", () => {
    expect(getModelDisplaySizeBytes(model({ size_bytes: 5 }))).toBe(5);
    const files = [{ filename: "a", quant: "Q4", size_bytes: 1 }, { filename: "b", quant: "Q8", size_bytes: 2 }];
    expect(getModelDisplaySizeBytes(model({ files, default_quant: "Q8" }))).toBe(2);
    expect(getModelDisplaySizeBytes(model({ files }))).toBe(1);
  });

  it("is null when nothing says", () => {
    expect(getModelDisplaySizeBytes(model({}))).toBeNull();
    expect(getModelDisplaySizeBytes(model({ files: [] }))).toBeNull();
  });
});
