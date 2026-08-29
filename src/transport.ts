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
  // Bound, not the raw reference: every provider stores this as
  // `this.fetchImpl` and later calls it as `this.fetchImpl(...)` — a method
  // call. Native `fetch` requires its receiver to be the realm's global
  // object; an unbound reference invoked that way throws
  // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
  // (or the equivalent in other engines). Binding here means every consumer
  // gets a safely-callable default without having to know to pass their own
  // `fetchImpl` just to work around this.
  return deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
