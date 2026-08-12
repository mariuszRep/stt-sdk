import type { SttProvider } from "./provider";
import type { RuntimeConnectionDescriptor } from "./types";
import type { TransportDeps } from "./transport";
import { UnsupportedCapabilityError } from "./errors";
import { FasterWhisperProvider } from "./providers/faster-whisper";
import { WhisperCppProvider } from "./providers/whisper-cpp";

/**
 * Build a provider from a server-issued {@link RuntimeConnectionDescriptor}.
 *
 * The SDK accepts descriptors for known local runtime protocols; it never
 * discovers hardware or supervises runtimes. Cloud providers are constructed
 * directly (e.g. `new DeepgramProvider({ apiKey })`) and never require a
 * server process.
 *
 * @param deps Optional transport seams (fetch/WebSocket overrides) forwarded to
 *   the constructed provider; useful for tests and non-default runtimes.
 */
export function createProvider(
  descriptor: RuntimeConnectionDescriptor,
  deps: TransportDeps = {},
): SttProvider {
  if (descriptor.schemaVersion !== 1) {
    throw new UnsupportedCapabilityError(
      `Unsupported runtime descriptor schemaVersion ${descriptor.schemaVersion}`,
    );
  }

  switch (descriptor.protocol) {
    case "voice-typer-v1":
      switch (descriptor.provider) {
        case "faster-whisper":
          return new FasterWhisperProvider({
            baseUrl: descriptor.baseUrl,
            streamingEndpoint: descriptor.streaming?.endpoint,
            auth: descriptor.auth?.value,
            fetchImpl: deps.fetchImpl,
            WebSocketImpl: deps.WebSocketImpl,
          });
        case "whisper-cpp":
          return new WhisperCppProvider({
            baseUrl: descriptor.baseUrl,
            streamingEndpoint: descriptor.streaming?.endpoint,
          });
        default:
          throw new UnsupportedCapabilityError(
            `No provider adapter for protocol "voice-typer-v1" provider "${descriptor.provider}".`,
          );
      }
    default:
      throw new UnsupportedCapabilityError(
        `No provider adapter for protocol "${descriptor.protocol}".`,
      );
  }
}
