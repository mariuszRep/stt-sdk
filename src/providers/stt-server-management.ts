/**
 * Client for stt-server's model-manager and local-admin surface
 * (`/models/manage/*`, `/v1/local/*`, `/health`, `/readiness`) — the model-lifecycle half of the server's API
 * (see `stt-server`'s `docs/client-contract.md` §4 and §9). Transcription itself goes through
 * `SttServerProvider`, which does no model management by design; this class does no transcription.
 * It calls the server — it installs and loads nothing itself.
 *
 * Every call here uses the admin token (`DesktopServerConnection.token` in the desktop app): every
 * `/models/manage/*` write and `/v1/local/config` are admin-only per the contract's §3 route table.
 */

import { fromSttServerManaged, sttServerManagedState } from "../registry/adapters/stt-server";
import { compact } from "../registry/adapters/shared";
import type { CapabilityMatrix } from "../registry/capabilities";
import { withUniqueNames } from "../registry/names";
import type { ManagedModel, SttServerCatalogStamp, SttServerRegistryDocument } from "../registry/sources";
import type { CatalogVersion, ModelEntry, ModelState } from "../registry/types";

export interface OperationState {
  operation_id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress_bytes?: number | null;
  total_bytes?: number | null;
  error?: string | null;
  error_code?: string | null;
  result?: unknown;
}

export interface OperationStarted {
  operation_id: string;
  state: string;
}

export interface DefaultModelResponse {
  model: string | null;
  effective_capabilities: CapabilityMatrix | null;
}

export interface SetDefaultResponse {
  model: string;
  backend: { observed_backend?: string; fallback_reason?: string | null };
}

export interface RemoveModelResponse {
  removed: boolean;
  file_deleted: boolean;
}

export interface ModelRecommendation {
  id: string;
  name: string;
  recommended_rank?: number | null;
  [key: string]: unknown;
}

export interface SystemInfo {
  os?: { name?: string; version?: string };
  cpu?: { model?: string; logical_cores?: number; physical_cores?: number };
  memory?: { total_bytes?: number; available_bytes?: number };
  gpu?: {
    vulkan_available?: boolean;
    devices?: { name: string; backend: string; memory_bytes?: number }[];
    note?: string;
  };
  process?: { pid?: number; uptime_ms?: number; rss_bytes?: number };
  server?: { version?: string; host?: string; port?: number; data_dir?: string };
  /** The embedded model catalog's version; absent on an older server. */
  catalog?: SttServerCatalogStamp;
}

/** The models of {@link SttServerManagement.listRegistryEntries}: entries and states line up by `ref`. */
export interface RegistryListing {
  entries: ModelEntry[];
  states: ModelState[];
  /** The server's catalog number (`2`), when the server reports it (`GET /v1/registry`). Not comparable with the SDK's date strings. */
  catalogVersion?: CatalogVersion;
  /** When the server's catalog was generated (ISO 8601 text), when it reports it. */
  generatedAt?: string;
}

export interface LocalConfig {
  cors_allowed_origins?: string[];
  user_models_dir?: string;
  network_mode?: "local" | "lan" | "tailscale";
  max_audio_bytes?: number;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: string;
  service?: string;
  version?: string;
  api_level?: number;
  network?: { mode: string; effective: string; reason?: string; addresses?: string[] };
  default_model?: string | null;
  loaded_model?: string | null;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  reason?: string;
  model?: string | null;
  elapsed_ms?: number;
  default_model?: string | null;
  loaded_model?: string | null;
  backend?: unknown;
}

/** Structured error mirroring the server's `{"error":{code,message,details}}`
 * envelope (client-contract.md §6), so callers can branch on `code` instead
 * of parsing message text. */
export class ModelManagerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = "ModelManagerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** The server refused a model request only because it is busy loading (`model_loading`) or serving a stream
 * (`engine_busy`): it clears by itself, so callers wait and retry instead of failing. */
export function isModelBusyError(err: unknown): boolean {
  return err instanceof ModelManagerError && (err.code === "model_loading" || err.code === "engine_busy");
}

const SET_DEFAULT_TIMEOUT_MS = 120_000;

/** How long {@link SttServerManagement.setDefaultModelWhenIdle} waits for the server to finish loading. */
export const MODEL_BUSY_WAIT_MS = 180_000;

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export interface SttServerManagementOptions {
  baseUrl: string;
  /** Admin token (from `get_server_connection().token`). Required for every
   * call in this file except {@link getHealth}. */
  token: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s) -- every call in this file used
   * to have no timeout at all, so an unresponsive server (a hung process, a
   * dropped LAN connection) left a caller waiting forever instead of
   * surfacing a clear error (review-2026-09-28.md #3). Does not apply to
   * {@link pollOperation}, which already has its own long-running-by-design
   * loop with its own `signal`. */
  timeoutMs?: number;
}

/** Connection shape needed to pick the right token -- structurally
 * compatible with `DesktopServerConnection` (see `lib/api.ts`) without
 * importing it here, to keep this file's dependency direction one-way. */
export interface TokenBearingConnection {
  token?: string | null;
  userToken?: string | null;
}

/**
 * The token `SttServerManagement` must be constructed with: every
 * `/models/manage/*` write and `/v1/local/config` is admin-only per
 * stt-server's client-contract.md §3 route table, so this is always
 * `connection.token` (the admin token) -- never `userToken`, which gets a
 * 403 `admin_required` from those routes. Transcription (see `api.ts`'s
 * `transcribe`) is the one place `userToken` should be preferred instead.
 */
export function managementToken(connection: TokenBearingConnection): string {
  const token = connection.token;
  if (!token) {
    throw new Error("No auth token available yet (the speech server is still starting)");
  }
  return token;
}

interface ServerErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/** Thin wrapper around every `/models/manage`, `/v1/local/*`, `/health` and
 * `/readiness` call, plus an operation-polling helper. One instance per
 * `DesktopServerConnection`. */
export class SttServerManagement {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SttServerManagementOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    { auth = true }: { auth?: boolean } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: { ...(auth ? this.authHeaders() : {}), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      throw new ModelManagerError(
        `Failed to reach stt-server ${path}: ${err instanceof Error ? err.message : String(err)}`,
        "connection_error",
        0,
        { cause: err },
      );
    }
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async toError(res: Response): Promise<ModelManagerError> {
    let body: ServerErrorBody | null = null;
    try {
      body = (await res.json()) as ServerErrorBody;
    } catch {
      // non-JSON error body; fall through to a generic message
    }
    const code = body?.error?.code ?? "api_error";
    const message = body?.error?.message ?? `stt-server request failed: ${res.status}`;
    return new ModelManagerError(message, code, res.status, body?.error?.details);
  }

  // ---- Model manager (/models/manage) ----

  /** The catalog, each model under a name of its own (two entries can share one: `withUniqueNames`). */
  async listManagedModels(): Promise<ManagedModel[]> {
    const body = await this.request<{ data?: ManagedModel[] }>("/models/manage");
    return withUniqueNames(body.data ?? []);
  }

  /**
   * Every model the server serves as registry entries, with what is installed, verified and default as state. Entries
   * and states line up by `ref`. A current server answers `GET /v1/registry` itself, in the registry's own shape: the
   * catalog and any drop-in model (whether installed or not) and the models compiled into it (`builtin`, the speaker
   * and VAD models), so filter on `kind` for a list of speech models. An older server has no such route (404): its
   * `/models/manage` rows go through the adapters instead, speech models only and with no catalog version.
   */
  async listRegistryEntries(): Promise<RegistryListing> {
    try {
      const body = await this.request<SttServerRegistryDocument>("/v1/registry");
      return compact({
        entries: withUniqueNames(body.data),
        states: body.states,
        catalogVersion: body.catalog_version,
        generatedAt: body.generated_at,
      });
    } catch (err) {
      if (!(err instanceof ModelManagerError && err.status === 404)) throw err;
    }
    const rows = await this.listManagedModels();
    return { entries: rows.map(fromSttServerManaged), states: rows.map(sttServerManagedState) };
  }

  async getRecommendations(): Promise<ModelRecommendation[]> {
    const body = await this.request<{ data?: ModelRecommendation[] }>("/models/manage/recommendations");
    return body.data ?? [];
  }

  async downloadModel(id: string): Promise<OperationStarted> {
    return this.request<OperationStarted>(`/models/manage/${encodeURIComponent(id)}/download`, {
      method: "POST",
    });
  }

  async verifyModel(id: string): Promise<OperationStarted> {
    return this.request<OperationStarted>(`/models/manage/${encodeURIComponent(id)}/verify`, {
      method: "POST",
    });
  }

  /** Sets `id` as the default model and loads it (client-contract.md §4). */
  async setDefaultModel(id: string): Promise<SetDefaultResponse> {
    // The call returns once the model is loaded, which takes longer than a normal request's timeout on a cold start.
    return this.request<SetDefaultResponse>(`/models/manage/${encodeURIComponent(id)}/default`, {
      method: "POST",
      signal: AbortSignal.timeout(SET_DEFAULT_TIMEOUT_MS),
    });
  }

  /**
   * {@link setDefaultModel}, but while the server is busy loading (its startup reload of the previous default, another
   * switch) it backs off and retries, up to `MODEL_BUSY_WAIT_MS`, calling `onWaiting` on each refusal. Done as soon as
   * `/readiness` reports `id` itself loaded (the startup reload was this very model). Any other failure -- the server
   * gone, the model invalid -- is thrown at once.
   */
  async setDefaultModelWhenIdle(
    id: string,
    { signal, onWaiting, waitMs = MODEL_BUSY_WAIT_MS }: { signal?: AbortSignal; onWaiting?: () => void; waitMs?: number } = {},
  ): Promise<SetDefaultResponse> {
    const deadline = Date.now() + waitMs;
    let backoffMs = 500;
    for (;;) {
      try {
        return await this.setDefaultModel(id);
      } catch (err) {
        if (!isModelBusyError(err)) throw err;
        if (Date.now() >= deadline) {
          throw new Error("The speech server is still busy loading a model. Try again in a moment.");
        }
        onWaiting?.();
        const readiness = await this.getReadiness().catch(() => null);
        if (readiness?.status === "ready" && readiness.loaded_model === id) return { model: id, backend: {} };
        await sleepUnlessAborted(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 1.5, 5_000);
      }
    }
  }

  async getDefaultModel(): Promise<DefaultModelResponse> {
    return this.request<DefaultModelResponse>("/models/manage/default");
  }

  /** Unloads the currently loaded model (does not change what's downloaded). */
  async clearDefaultModel(): Promise<{ model: null; loaded: false }> {
    return this.request("/models/manage/default", { method: "DELETE" });
  }

  async removeModel(id: string): Promise<RemoveModelResponse> {
    return this.request<RemoveModelResponse>(`/models/manage/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** Re-scans the drop-in models folder for manually copied files. */
  async refreshModels(): Promise<OperationStarted> {
    return this.request<OperationStarted>("/models/manage/refresh", { method: "POST" });
  }

  async getOperation(operationId: string): Promise<OperationState> {
    return this.request<OperationState>(`/models/manage/operations/${encodeURIComponent(operationId)}`);
  }

  async cancelOperation(operationId: string): Promise<void> {
    await this.request(`/models/manage/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: "POST",
    });
  }

  /**
   * Polls {@link getOperation} until it reaches a terminal state, reporting
   * progress via `onProgress`. Throws {@link CancelledError} if the
   * operation ends `cancelled`, or an `Error` with the server's message if
   * it ends `failed`. `signal` aborts the polling loop itself (does not
   * cancel the operation server-side — call {@link cancelOperation}
   * explicitly for that).
   */
  async pollOperation(
    operationId: string,
    {
      onProgress,
      intervalMs = 500,
      signal,
    }: {
      onProgress?: (state: OperationState) => void;
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<OperationState> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
      const state = await this.getOperation(operationId);
      onProgress?.(state);
      if (state.state === "completed") return state;
      if (state.state === "cancelled") throw new CancelledError();
      if (state.state === "failed") throw new Error(state.error ?? "operation failed");
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, intervalMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            reject(new DOMException("Operation aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
  }

  /** Convenience: start a download and poll it to completion/failure. */
  async downloadModelAndWait(
    id: string,
    opts?: { onProgress?: (state: OperationState) => void; signal?: AbortSignal },
  ): Promise<void> {
    const { operation_id } = await this.downloadModel(id);
    await this.pollOperation(operation_id, opts);
  }

  // ---- Local admin (/v1/local/*) ----

  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>("/v1/local/system");
  }

  async getConfig(): Promise<LocalConfig> {
    return this.request<LocalConfig>("/v1/local/config");
  }

  async patchConfig(patch: Partial<LocalConfig>): Promise<LocalConfig> {
    return this.request<LocalConfig>("/v1/local/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  // ---- Liveness ----

  /** Unauthenticated — the only route that needs no token. */
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health", undefined, { auth: false });
  }

  async getReadiness(): Promise<ReadinessResponse> {
    // /readiness returns 503 while not ready, which our request() treats as
    // an error — but the body is still meaningful, so read it directly.
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/readiness`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ModelManagerError(
        `Failed to reach stt-server /readiness: ${err instanceof Error ? err.message : String(err)}`,
        "connection_error",
        0,
        { cause: err },
      );
    }
    const text = await res.text();
    if (!text) throw new ModelManagerError("Empty /readiness response", "invalid_response", res.status);
    return JSON.parse(text) as ReadinessResponse;
  }
}
