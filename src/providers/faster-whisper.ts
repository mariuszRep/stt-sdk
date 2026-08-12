import type { SttProvider } from "../provider";
import type { TransportDeps } from "../transport";
import { resolveFetch, resolveWebSocket, toArrayBuffer, toBlob } from "../transport";
import type {
  BatchTranscriptionRequest,
  ModelInfo,
  ProviderCapability,
  StreamConfig,
  StreamSession,
  SessionState,
  TranscriptEvent,
  TranscriptionResult,
} from "../types";
import { ApiError, ConnectionError, ProtocolError } from "../errors";

export interface FasterWhisperOptions extends TransportDeps {
  /** Base URL of the local runtime, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  /** WebSocket streaming endpoint, default `/v1/audio/stream`. */
  streamingEndpoint?: string;
  /** Optional auth token (LAN mode); sent as `auth` in the `start` message. */
  auth?: string;
  /** Fallback close delay for graceful `stop()`, default 5000ms. */
  stopTimeoutMs?: number;
}

interface ConfigResponse {
  schema_version?: number;
  model: string;
}

interface TranscriptionResponse {
  text: string;
}

/**
 * Local Faster Whisper runtime adapter.
 *
 * Preserves the App's current wire behavior exactly:
 * - batch: multipart `POST /v1/audio/transcriptions` with `file` + optional
 *   `prompt`, response `{ text }`;
 * - stream: `WS /v1/audio/stream` protocol v1 — `start` → `ready` → binary PCM
 *   → `partial`/`final`/`lagging`/`error` → `stop`/`abort` → `closed`.
 *
 * Unknown event types and unknown fields are tolerated and forwarded.
 */
export class FasterWhisperProvider implements SttProvider {
  readonly id = "faster-whisper";
  readonly capability: ProviderCapability = {
    id: "faster-whisper",
    displayName: "Faster Whisper (local)",
    transport: "http",
    requiresAudioInput: true,
    privacy: "local",
    supportsPartials: true,
    supportsWordTimestamps: false,
    supportsLanguageHint: true,
    supportsStreaming: true,
    supportsBatch: true,
    available: true,
  };

  private readonly baseUrl: string;
  private readonly streamingEndpoint: string;
  private readonly auth: string | undefined;
  private readonly stopTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(options: FasterWhisperOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.streamingEndpoint = options.streamingEndpoint ?? "/v1/audio/stream";
    this.auth = options.auth;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.fetchImpl = resolveFetch(options);
    this.WebSocketImpl = resolveWebSocket(options);
  }

  async listModels(): Promise<ModelInfo[]> {
    // The current runtime exposes the active model through /v1/config; there is
    // no models catalog endpoint yet. The configured model is the only model.
    const config = (await this.getConfig()) as ConfigResponse;
    return [{ id: config.model, name: config.model }];
  }

  private async getConfig(): Promise<ConfigResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/config`);
    } catch (err) {
      throw new ConnectionError("Config fetch failed", { cause: err });
    }
    if (!res.ok) {
      throw new ApiError(`Config fetch failed: ${res.status}`, { status: res.status });
    }
    return (await res.json()) as ConfigResponse;
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    // Wire contract preserved from the App: multipart `file` (+ optional
    // `prompt`), POST /v1/audio/transcriptions, response `{ text }`.
    const form = new FormData();
    form.append("file", toBlob(request.file), request.filename ?? "recording.webm");
    if (request.prompt && request.prompt.trim()) {
      form.append("prompt", request.prompt.trim());
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: request.signal,
      });
    } catch (err) {
      throw new ConnectionError("Transcription request failed", { cause: err });
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new ApiError(`Transcription failed: ${res.status} ${errorText}`, {
        status: res.status,
        code: "transcription_failed",
      });
    }

    const body = (await res.json()) as TranscriptionResponse;
    return { text: body.text ?? "" };
  }

  async createStream(config: StreamConfig): Promise<StreamSession> {
    const session = new FasterWhisperStreamSession(
      {
        baseUrl: this.baseUrl,
        streamingEndpoint: this.streamingEndpoint,
        stopTimeoutMs: this.stopTimeoutMs,
        WebSocketImpl: this.WebSocketImpl,
      },
      {
        ...config,
        // Descriptor-level auth (LAN mode) is sent in the protocol v1 `start`
        // message unless the caller overrides it per session.
        auth: config.auth ?? this.auth,
      },
    );
    await session.start();
    return session;
  }
}

interface FasterWhisperStreamOptions {
  baseUrl: string;
  streamingEndpoint: string;
  stopTimeoutMs: number;
  WebSocketImpl: typeof WebSocket;
}

class FasterWhisperStreamSession implements StreamSession {
  private ws: WebSocket | null = null;
  private readonly pendingAudio: ArrayBuffer[] = [];
  private wsReady = false;
  private _state: SessionState = "idle";

  onEvent: ((event: TranscriptEvent) => void) | null = null;
  onStateChange: ((state: SessionState) => void) | null = null;

  get state(): SessionState {
    return this._state;
  }

  constructor(
    private readonly opts: FasterWhisperStreamOptions,
    private readonly config: StreamConfig,
  ) {}

  /** Opens the socket and resolves once the server confirms `ready`. */
  async start(): Promise<void> {
    this._state = "starting";
    this.onStateChange?.(this._state);

    const wsUrl = this.opts.baseUrl.replace(/^http/, "ws") + this.opts.streamingEndpoint;
    const WS = this.opts.WebSocketImpl;

    return new Promise<void>((resolve, reject) => {
      const ws = new WS(wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        // Protocol v1 start message, field-for-field as the historical App client.
        ws.send(
          JSON.stringify({
            type: "start",
            protocolVersion: 1,
            language: this.config.language,
            model: this.config.model,
            encoding: this.config.encoding,
            sampleRate: this.config.sampleRate,
            channels: this.config.channels,
            prompt: this.config.prompt,
            auth: this.config.auth,
          }),
        );
      };

      ws.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        let event: TranscriptEvent;
        try {
          event = JSON.parse(e.data) as TranscriptEvent;
        } catch {
          return;
        }

        if (event.type === "ready") {
          this._state = "active";
          this.onStateChange?.(this._state);
          this.wsReady = true;
          // Flush audio buffered while the socket was connecting.
          for (const buf of this.pendingAudio) {
            ws.send(buf);
          }
          this.pendingAudio.length = 0;
          resolve();
        } else if (event.type === "error" && !this.wsReady && this.ws === ws) {
          // Fatal errors before `ready` reject the start promise (App behavior).
          // After `ready`, error events are forwarded: protocol v1 documents
          // non-fatal (`retryable: true`) errors as deliverable without closing
          // the session (the historical App client swallowed them).
          reject(new ProtocolError(event.message, { code: event.code, retryable: event.retryable }));
          return;
        }

        // Forward every parsed event, including unknown types (tolerance).
        this.onEvent?.(event);
      };

      ws.onerror = () => {
        if (this.ws) {
          this.onEvent?.({
            type: "error",
            code: "connection_failed",
            message: "WebSocket connection failed",
            retryable: true,
          });
        }
        reject(new ConnectionError("WebSocket connection failed"));
      };

      ws.onclose = () => {
        if (this.ws) {
          this.ws = null;
          this._state = "closed";
          this.onStateChange?.(this._state);
        }
      };
    });
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    const buf = toArrayBuffer(pcm);
    if (this.ws && this.ws.readyState === this.opts.WebSocketImpl.OPEN && this.wsReady) {
      this.ws.send(buf);
    } else {
      // Buffer until the socket is open and the server confirmed "ready".
      this.pendingAudio.push(buf);
    }
  }

  async stop(): Promise<void> {
    this._state = "stopping";
    this.onStateChange?.(this._state);
    this.wsReady = false;
    this.pendingAudio.length = 0;

    const ws = this.ws;
    if (ws && ws.readyState === this.opts.WebSocketImpl.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    // Server sends `closed` then closes; close as a fallback otherwise.
    setTimeout(() => {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }, this.opts.stopTimeoutMs);
  }

  abort(): void {
    this.wsReady = false;
    this.pendingAudio.length = 0;

    const ws = this.ws;
    if (ws && ws.readyState === this.opts.WebSocketImpl.OPEN) {
      ws.send(JSON.stringify({ type: "abort" }));
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._state = "closed";
    this.onStateChange?.(this._state);
    this.onEvent?.({ type: "closed", reason: "client_abort" });
  }
}
