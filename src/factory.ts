import type { SttProvider } from "./provider";
import type { ProviderCapability, RuntimeConnectionDescriptor } from "./types";
import type { TransportDeps } from "./transport";
import { UnsupportedCapabilityError } from "./errors";
import { LocalRuntimeProvider } from "./providers/local-runtime";

function capabilityFor(descriptor: RuntimeConnectionDescriptor): ProviderCapability {
  return {
    id: descriptor.provider,
    displayName: `${descriptor.provider} (local)`,
    transport: "http",
    requiresAudioInput: true,
    privacy: "local",
    supportsPartials: true,
    supportsWordTimestamps: false,
    supportsLanguageHint: true,
    // No local runtime advertises streaming today (see LocalRuntimeProvider's
    // own doc comment); a descriptor's `streaming.enabled` is intentionally
    // NOT read here — seams.test.ts pins that a descriptor advertising it
    // still yields a batch-only provider, since createStream() isn't wired
    // to actually use it yet regardless of what a runtime claims.
    supportsStreaming: false,
    supportsBatch: true,
    available: true,
  };
}

/**
 * Build a provider from a server-issued {@link RuntimeConnectionDescriptor}.
 *
 * The SDK accepts descriptors for known local runtime protocols; it never
 * discovers hardware or supervises runtimes. Cloud providers are constructed
 * directly (e.g. `new DeepgramProvider({ apiKey })`) and never require a
 * server process.
 *
 * Local runtimes are selected on `descriptor.protocol`, not
 * `descriptor.provider` — any runtime speaking `"voice-typer-v1"` works
 * here, including ones this SDK has never heard the name of. This is what
 * makes the SDK usable standalone against a caller's own conformant
 * runtime, and means adding a new engine on the `stt-server` side never
 * requires an SDK release. `descriptor.provider` is surfaced only as
 * `capability.id`/`displayName`, for diagnostics — never used to pick a
 * different code path. A genuinely unknown `protocol` (not just an
 * unrecognized engine name) still throws: that's a real wire-contract
 * incompatibility, not a naming gap.
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
      return new LocalRuntimeProvider({
        id: descriptor.provider,
        capability: capabilityFor(descriptor),
        baseUrl: descriptor.baseUrl,
        auth: descriptor.auth,
        fetchImpl: deps.fetchImpl,
        WebSocketImpl: deps.WebSocketImpl,
      });
    default:
      throw new UnsupportedCapabilityError(
        `No provider adapter for protocol "${descriptor.protocol}".`,
      );
  }
}
