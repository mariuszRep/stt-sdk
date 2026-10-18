import type { SessionState, StreamConfig, StreamSession, TranscriptEvent } from "../types";
import { toArrayBuffer } from "../transport";
import { ConnectionError, ProtocolError, UnsupportedCapabilityError, type SttError } from "../errors";

/**
 * Opens a WebSocket carrying the bearer token. A browser `WebSocket` cannot set request headers, so a webview
 * passes a factory of its own (a native socket, or a proxy); the default sends the header where the platform allows
 * it (Node's `WebSocket` takes `{ headers }` as its second argument).
 */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

export interface SttServerStreamOptions {
  /** `ws://host:port/v1/realtime?intent=transcription&model=...` */
  url: string;
  token: string;
  openSocket: WebSocketFactory;
  /** How long `start` waits for the session to be confirmed. */
  connectTimeoutMs: number;
  /** How long `stop` waits for the last transcript before closing anyway. */
  stopTimeoutMs: number;
}

/** The server's PCM is always 16-bit little-endian mono: `input_audio_format: "pcm16"`. */
const BYTES_PER_SAMPLE = 2;

interface ServerEvent {
  type?: string;
  item_id?: string;
  committed?: string;
  tentative?: string;
  revision?: number;
  transcript?: string;
  error?: { code?: string; message?: string };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function parseEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as ServerEvent;
  } catch {
    return null;
  }
}

function startError(event: ServerEvent): SttError {
  const code = event.error?.code ?? "server_error";
  const message = event.error?.message ?? code;
  if (code === "streaming_unsupported") return new UnsupportedCapabilityError(message);
  return new ProtocolError(message, { code });
}

/**
 * One live transcription over stt-server's `/v1/realtime` (client-contract.md section 5a): the audio sent is one
 * item, `stop()` commits it and resolves once the final text has arrived. `partial` events carry the committed and
 * the still-changing (tentative) text; their `text` is the two together.
 */
export class SttServerStreamSession implements StreamSession {
  onEvent: ((event: TranscriptEvent) => void) | null = null;
  onStateChange: ((state: SessionState) => void) | null = null;

  private ws: WebSocket | null = null;
  private _state: SessionState = "idle";
  private ready = false;
  private pendingAudio: Uint8Array[] = [];
  private sentSamples = 0;
  private finish: (() => void) | null = null;
  private item = "item";

  constructor(
    private readonly options: SttServerStreamOptions,
    private readonly config: StreamConfig,
  ) {}

  get state(): SessionState {
    return this._state;
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.onStateChange?.(state);
  }

  private sentMs(): number {
    return Math.round((this.sentSamples / this.config.sampleRate) * 1000);
  }

  /** Opens the socket and resolves once the server has accepted the session settings. */
  start(): Promise<void> {
    this.setState("starting");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: SttError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dispose();
        this.setState("closed");
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new ConnectionError("stt-server did not confirm the live session in time.")),
        this.options.connectTimeoutMs,
      );
      let ws: WebSocket;
      try {
        ws = this.options.openSocket(this.options.url, { Authorization: `Bearer ${this.options.token}` });
      } catch (cause) {
        fail(new ConnectionError("Failed to open the stt-server live socket.", { cause }));
        return;
      }
      this.ws = ws;

      ws.onmessage = (e: MessageEvent) => {
        const event = parseEvent(e.data);
        if (!event) return;
        if (this.ready) {
          this.handle(event);
        } else if (event.type === "error") {
          fail(startError(event));
        } else if (event.type === "transcription_session.created") {
          ws.send(JSON.stringify(this.sessionUpdate()));
        } else if (event.type === "transcription_session.updated") {
          settled = true;
          clearTimeout(timer);
          this.becomeReady();
          resolve();
        }
      };
      ws.onerror = () => {
        if (!this.ready) fail(new ConnectionError("stt-server live socket failed."));
      };
      ws.onclose = () => {
        if (!this.ready) fail(new ConnectionError("stt-server closed the live socket before the session began."));
        else this.lost();
      };
    });
  }

  private becomeReady(): void {
    this.ready = true;
    this.setState("active");
    this.onEvent?.({
      type: "ready",
      sessionId: "",
      provider: "stt-server",
      protocolVersion: 1,
      model: this.config.model,
      language: this.config.language ?? "",
      sampleRate: this.config.sampleRate,
      channels: 1,
    });
    for (const audio of this.pendingAudio) this.append(audio);
    this.pendingAudio = [];
  }

  private sessionUpdate(): Record<string, unknown> {
    const transcription: Record<string, string> = {};
    if (this.config.model && this.config.model !== "default") transcription.model = this.config.model;
    if (this.config.language) transcription.language = this.config.language;
    if (this.config.targetLanguage) transcription.target_language = this.config.targetLanguage;
    if (this.config.prompt) transcription.prompt = this.config.prompt;
    return {
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_sample_rate: this.config.sampleRate,
        input_audio_transcription: transcription,
        turn_detection: null,
      },
    };
  }

  private handle(event: ServerEvent): void {
    this.item = event.item_id ?? this.item;
    switch (event.type) {
      case "conversation.item.input_audio_transcription.partial": {
        const committed = event.committed ?? "";
        const tentative = event.tentative ?? "";
        this.onEvent?.({
          type: "partial",
          id: this.item,
          text: committed + tentative,
          startMs: 0,
          endMs: this.sentMs(),
          committed,
          tentative,
          revision: event.revision ?? 0,
        });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        this.onEvent?.({ type: "final", id: this.item, text: event.transcript ?? "", startMs: 0, endMs: this.sentMs() });
        if (this._state === "stopping") this.close("client_stop");
        break;
      case "error": {
        const code = event.error?.code ?? "server_error";
        // Nothing was said: there is no transcript to wait for.
        if (code === "input_audio_buffer_commit_empty" && this._state === "stopping") {
          this.close("client_stop");
        } else {
          this.onEvent?.({ type: "error", code, message: event.error?.message ?? code, retryable: false });
        }
        break;
      }
    }
  }

  /** The server closed the socket under a running session. */
  private lost(): void {
    if (this._state === "closed") return;
    const stopping = this._state === "stopping";
    if (!stopping) {
      this.onEvent?.({ type: "error", code: "connection_lost", message: "stt-server closed the live socket.", retryable: true });
    }
    this.ws = null;
    this.setState("closed");
    this.onEvent?.({ type: "closed", reason: stopping ? "client_stop" : "error" });
    this.finish?.();
  }

  private append(audio: Uint8Array): void {
    this.sentSamples += audio.length / BYTES_PER_SAMPLE;
    this.ws?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(audio) }));
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    if (this._state === "stopping" || this._state === "closed") return;
    const bytes = new Uint8Array(toArrayBuffer(pcm));
    if (bytes.length === 0) return;
    if (this.ready) this.append(bytes);
    else this.pendingAudio.push(bytes);
  }

  stop(): Promise<void> {
    if (this._state === "closed") return Promise.resolve();
    this.setState("stopping");
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.close("client_stop"), this.options.stopTimeoutMs);
      this.finish = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.sentSamples === 0) this.close("client_stop");
      else this.ws?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    });
  }

  abort(): void {
    if (this._state === "closed") return;
    if (this.ready) this.ws?.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    this.close("client_abort");
  }

  private close(reason: "client_stop" | "client_abort"): void {
    if (this._state === "closed") return;
    this.setState("closed");
    this.dispose();
    this.onEvent?.({ type: "closed", reason });
    this.finish?.();
  }

  private dispose(): void {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.pendingAudio = [];
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}
