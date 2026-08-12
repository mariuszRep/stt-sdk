/**
 * Injectable transport seams. Public adapters accept optional `fetchImpl` and
 * `WebSocketImpl` overrides (defaulting to the platform globals) so contract
 * tests can drive the exact wire behavior without a live server.
 */

export interface TransportDeps {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export function resolveFetch(deps: TransportDeps): typeof fetch {
  return deps.fetchImpl ?? globalThis.fetch;
}

export function resolveWebSocket(deps: TransportDeps): typeof WebSocket {
  return deps.WebSocketImpl ?? globalThis.WebSocket;
}

export function toBlob(file: Blob | ArrayBuffer | Uint8Array): Blob {
  return file instanceof Blob ? file : new Blob([file]);
}

export function toArrayBuffer(pcm: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (pcm instanceof ArrayBuffer) return pcm;
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}
