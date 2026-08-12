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
