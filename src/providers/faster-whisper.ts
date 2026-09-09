import type { ProviderCapability } from "../types";
import type { TransportDeps } from "../transport";
import { LocalRuntimeProvider } from "./local-runtime";

export interface FasterWhisperOptions extends TransportDeps {
  /** Base URL of the local runtime, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
}

const FASTER_WHISPER_CAPABILITY: ProviderCapability = {
  id: "faster-whisper",
  displayName: "Faster Whisper (local)",
  transport: "http",
  requiresAudioInput: true,
  privacy: "local",
  supportsPartials: true,
  supportsWordTimestamps: false,
  supportsLanguageHint: true,
  supportsStreaming: false,
  supportsBatch: true,
  available: true,
};

/**
 * Named, source-compatible alias for the shared {@link LocalRuntimeProvider}
 * with `id`/`capability` fixed to their historical `"faster-whisper"`
 * values. `createProvider` no longer dispatches to this class specifically
 * (it selects on `descriptor.protocol`, see `factory.ts`) — this remains
 * exported and directly constructible only so existing `new
 * FasterWhisperProvider({ baseUrl })` call sites keep working unchanged.
 * Its wire behavior *is* `LocalRuntimeProvider`'s; nothing here is
 * faster-whisper-specific anymore.
 */
export class FasterWhisperProvider extends LocalRuntimeProvider {
  constructor(options: FasterWhisperOptions) {
    super({
      ...options,
      id: "faster-whisper",
      capability: FASTER_WHISPER_CAPABILITY,
    });
  }
}
