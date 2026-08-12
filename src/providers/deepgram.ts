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

export interface DeepgramOptions extends TransportDeps {
  /** Deepgram API key. */
  apiKey: string;
  /** API base URL, default `https://api.deepgram.com`. */
  baseUrl?: string;
  /** Fallback close delay for graceful `stop()`, default 5000ms. */
  stopTimeoutMs?: number;
}

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramAlternative {
  transcript: string;
  confidence?: number;
  words?: DeepgramWord[];
}

interface DeepgramResultsMessage {
  type: "Results";
  is_final: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: DeepgramAlternative[];
  };
}

interface DeepgramMetadataMessage {
  type: "Metadata";
  request_id?: string;
  duration?: number;
  channels?: number;
  models?: string[];
}

interface DeepgramErrorMessage {
  type: "Error";
  err_code?: string;
  variant?: string;
  description?: string;
  message?: string;
}

interface DeepgramBatchResponse {
  metadata?: { duration?: number; request_id?: string };
  results?: {
    channels?: Array<{ alternatives?: DeepgramAlternative[] }>;
  };
}

interface DeepgramModelsResponse {
  models?: Array<{ name?: string; type?: string }>;
}

/**
 * Deepgram cloud adapter — the selected initial cloud contract proof.
 *
 * Verified against fixtures through the same public {@link SttProvider}
 * interface; cloud use requires no `stt-server` process. Mapping follows the
 * Voice Typer protocol reference: Deepgram `is_final: false` → `partial`,
 * `is_final: true` → `final`.
 *
 * Wire contract:
 * - batch: `POST {base}/v1/listen` with `Authorization: Token <key>`, multipart
 *   `audio` field, query params `model`/`language`/`punctuate`/`smart_format`;
 * - stream: `wss://{base}/v1/listen?token=<key>&model&language&encoding=linear16&
 *   sample_rate&channels&interim_results=true`, binary PCM frames, control
 *   message `{"type":"CloseStream"}`, server events `Metadata`/`Results`/`Error`.
 */
export class DeepgramProvider implements SttProvider {
  readonly id = "deepgram";
  readonly capability: ProviderCapability = {
    id: "deepgram",
    displayName: "Deepgram",
    transport: "websocket",
    requiresAudioInput: true,
    privacy: "cloud",
    supportsPartials: true,
    supportsWordTimestamps: true,
    supportsLanguageHint: true,
    supportsStreaming: true,
    supportsBatch: true,
    available: true,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly stopTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(options: DeepgramOptions) {
    if (!options.apiKey) {
      throw new Error("DeepgramProvider requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.deepgram.com").replace(/\/$/, "");
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.fetchImpl = resolveFetch(options);
    this.WebSocketImpl = resolveWebSocket(options);
  }

  async listModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
    } catch (err) {
      throw new ConnectionError("Deepgram models request failed", { cause: err });
    }
    if (!res.ok) {
      throw new ApiError(`Deepgram models request failed: ${res.status}`, { status: res.status });
    }
    const body = (await res.json()) as DeepgramModelsResponse;
    return (body.models ?? []).map((m) => ({ id: m.name ?? "unknown", name: m.name }));
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<TranscriptionResult> {
    const url = new URL("/v1/listen", this.baseUrl);
    if (request.model) url.searchParams.set("model", request.model);
    if (request.language) url.searchParams.set("language", request.language);
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");

    const form = new FormData();
    form.append("audio", toBlob(request.file), request.filename ?? "recording.webm");

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}` },
        body: form,
        signal: request.signal,
      });
    } catch (err) {
      throw new ConnectionError("Deepgram transcription request failed", { cause: err });
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new ApiError(`Deepgram transcription failed: ${res.status} ${errorText}`, {
        status: res.status,
        code: "transcription_failed",
      });
    }

    const body = (await res.json()) as DeepgramBatchResponse;
    const alternative = body.results?.channels?.[0]?.alternatives?.[0];
    const words = alternative?.words ?? [];
    const segments: TranscriptionResult["segments"] =
      words.length > 0
        ? words.map((w) => ({
            text: w.word,
            startMs: Math.round(w.start * 1000),
            endMs: Math.round(w.end * 1000),
            probability: w.confidence,
          }))
        : undefined;

    return {
      text: alternative?.transcript ?? "",
      durationMs:
        body.metadata?.duration != null ? Math.round(body.metadata.duration * 1000) : undefined,
      segments,
    };
  }

  async createStream(config: StreamConfig): Promise<StreamSession> {
    const session = new DeepgramStreamSession(
      {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        stopTimeoutMs: this.stopTimeoutMs,
        WebSocketImpl: this.WebSocketImpl,
      },
      config,
    );
    await session.start();
    return session;
  }
}

interface DeepgramStreamOptions {
  baseUrl: string;
  apiKey: string;
  stopTimeoutMs: number;
  WebSocketImpl: typeof WebSocket;
}

class DeepgramStreamSession implements StreamSession {
  private ws: WebSocket | null = null;
  private readonly pendingAudio: ArrayBuffer[] = [];
  private wsReady = false;
  private _state: SessionState = "idle";
  private segmentCounter = 1;

  onEvent: ((event: TranscriptEvent) => void) | null = null;
  onStateChange: ((state: SessionState) => void) | null = null;

  get state(): SessionState {
    return this._state;
  }

  constructor(
    private readonly opts: DeepgramStreamOptions,
    private readonly config: StreamConfig,
  ) {}

  /** Opens the socket and resolves once Deepgram confirms the session (`Metadata`). */
  async start(): Promise<void> {
    this._state = "starting";
    this.onStateChange?.(this._state);

    const wsUrl = this.buildUrl();
    const WS = this.opts.WebSocketImpl;

    return new Promise<void>((resolve, reject) => {
      const ws = new WS(wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(e.data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (message.type === "Metadata") {
          this._state = "active";
          this.onStateChange?.(this._state);
          this.wsReady = true;
          for (const buf of this.pendingAudio) {
            ws.send(buf);
          }
          this.pendingAudio.length = 0;
          resolve();
        } else if (message.type === "Results") {
          this.handleResults(message as unknown as DeepgramResultsMessage);
        } else if (message.type === "Error") {
          const err = message as unknown as DeepgramErrorMessage;
          const code = err.err_code ?? err.variant ?? "deepgram_error";
          const text = err.description ?? err.message ?? "Deepgram streaming error";
          if (!this.wsReady && this.ws === ws) {
            reject(new ProtocolError(text, { code, retryable: false }));
            return;
          }
          this.onEvent?.({ type: "error", code, message: text, retryable: false });
        }
        // Unknown event types (SpeechStarted, UtteranceEnd, ...) are ignored.
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

  private buildUrl(): string {
    const wsBase = this.opts.baseUrl
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");
    const url = new URL("/v1/listen", wsBase);
    url.searchParams.set("token", this.opts.apiKey);
    url.searchParams.set("model", this.config.model || "nova-2");
    if (this.config.language) url.searchParams.set("language", this.config.language);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(this.config.sampleRate));
    url.searchParams.set("channels", String(this.config.channels));
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("punctuate", "true");
    return url.toString();
  }

  private handleResults(message: DeepgramResultsMessage): void {
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript ?? "";
    if (!text) return;

    const startMs = Math.round((message.start ?? 0) * 1000);
    const endMs = Math.round(((message.start ?? 0) + (message.duration ?? 0)) * 1000);
    const id = `dg-${this.segmentCounter}`;

    if (message.is_final) {
      const words =
        alternative?.words && alternative.words.length > 0
          ? alternative.words.map((w) => ({
              word: w.word,
              startMs: Math.round(w.start * 1000),
              endMs: Math.round(w.end * 1000),
              probability: w.confidence,
            }))
          : undefined;
      this.onEvent?.({ type: "final", id, text, startMs, endMs, words });
      this.segmentCounter += 1;
    } else {
      this.onEvent?.({ type: "partial", id, text, startMs, endMs });
    }
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    const buf = toArrayBuffer(pcm);
    if (this.ws && this.ws.readyState === this.opts.WebSocketImpl.OPEN && this.wsReady) {
      this.ws.send(buf);
    } else {
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
      // CloseStream triggers final results, then the server closes the socket.
      ws.send(JSON.stringify({ type: "CloseStream" }));
    }
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
      ws.close();
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
