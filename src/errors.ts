/**
 * Structured error hierarchy for the STT SDK.
 *
 * Every error carries a machine-readable `code` and a `retryable` flag so
 * consumers can branch on normalized semantics instead of provider-specific
 * string matching.
 */

export interface SttErrorOptions {
  code?: string;
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}

export class SttError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: SttErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SttError";
    this.code = options.code ?? "stt_error";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/** Thrown when a named adapter seam is not yet implemented. */
export class UnsupportedCapabilityError extends SttError {
  constructor(message: string) {
    super(message, { code: "unsupported_capability" });
    this.name = "UnsupportedCapabilityError";
  }
}

/** Network/transport failure (DNS, refused, socket error, aborted fetch). */
export class ConnectionError extends SttError {
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, { code: "connection_failed", retryable: options.retryable ?? true, cause: options.cause });
    this.name = "ConnectionError";
  }
}

/** The remote spoke an unexpected/unsupported protocol message. */
export class ProtocolError extends SttError {
  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, {
      code: options.code ?? "protocol_error",
      retryable: options.retryable ?? false,
      cause: options.cause,
    });
    this.name = "ProtocolError";
  }
}

/** The remote returned a non-success HTTP status. */
export class ApiError extends SttError {
  constructor(
    message: string,
    options: { status?: number; code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, {
      code: options.code ?? "api_error",
      retryable: options.retryable ?? false,
      status: options.status,
      cause: options.cause,
    });
    this.name = "ApiError";
  }
}

/**
 * Structured errors for `stt-server`, mapped from its JSON error
 * envelope (`{"error":{"code","message","details"}}`) to stable SDK codes.
 * See `SttServerProvider`'s error-mapping table for the full list; an
 * unrecognized server `code` still surfaces here, verbatim, via
 * {@link ServerError} rather than being swallowed.
 */

/** Base class for every structured error this provider raises from a parsed server response. */
export class ServerError extends SttError {
  readonly details?: unknown;
  constructor(
    message: string,
    options: { code: string; retryable?: boolean; status?: number; cause?: unknown; details?: unknown },
  ) {
    super(message, {
      code: options.code,
      retryable: options.retryable ?? false,
      status: options.status,
      cause: options.cause,
    });
    this.name = "ServerError";
    this.details = options.details;
  }
}

/** `server_not_ready` — no default model configured and nothing loading. */
export class ServerNotReadyError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "server_not_ready", retryable: false, ...options });
    this.name = "ServerNotReadyError";
  }
}

/** `model_loading` — retryable: the model is on its way, poll/retry. */
export class ModelLoadingError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "model_loading", retryable: true, ...options });
    this.name = "ModelLoadingError";
  }
}

/** `model_not_installed` — the named model isn't downloaded or isn't a known id. */
export class ModelNotInstalledError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "model_not_installed", retryable: false, ...options });
    this.name = "ModelNotInstalledError";
  }
}

/** `unsupported_capability` — the server rejected a field the model doesn't support. */
export class ServerUnsupportedCapabilityError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "unsupported_capability", retryable: false, ...options });
    this.name = "ServerUnsupportedCapabilityError";
  }
}

/** `engine_busy` / `queue_full` — retryable: the server is saturated right now. */
export class ServerBusyError extends ServerError {
  constructor(message: string, options: { code?: "engine_busy" | "queue_full"; status?: number; details?: unknown } = {}) {
    super(message, { code: options.code ?? "engine_busy", retryable: true, status: options.status, details: options.details });
    this.name = "ServerBusyError";
  }
}

/** `admin_required` — a valid user token was used on an admin-only route. */
export class AdminRequiredError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "admin_required", retryable: false, ...options });
    this.name = "AdminRequiredError";
  }
}

/** `unauthorized` — missing or invalid bearer token. */
export class UnauthorizedError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "unauthorized", retryable: false, ...options });
    this.name = "UnauthorizedError";
  }
}

/** `network_not_private` — a non-loopback caller rejected under lan/tailscale mode. */
export class NetworkNotPrivateError extends ServerError {
  constructor(message: string, options: { status?: number; details?: unknown } = {}) {
    super(message, { code: "network_not_private", retryable: false, ...options });
    this.name = "NetworkNotPrivateError";
  }
}

/** The server exists but fails the `service`/`api_level` version check. */
export class ServerVersionError extends ServerError {
  constructor(
    message: string,
    options: { code: "server_too_old" | "not_stt_server"; details?: unknown },
  ) {
    super(message, { code: options.code, retryable: false, details: options.details });
    this.name = "ServerVersionError";
  }
}
