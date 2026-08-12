# @voice-typer/stt-sdk

Voice Typer provider-communication library. One normalized TypeScript interface for
local STT runtime endpoints (Faster Whisper, Whisper.cpp) and cloud STT APIs
(Deepgram, OpenAI, Groq) — without taking on server lifecycle responsibilities.

This package is the **sole public provider contract** for the Voice Typer product.
It is independently versioned and published; it never depends on `stt-server` and
contains no hardware detection, installation, model lifecycle, process supervision,
or inference.

## Install

```bash
npm install @voice-typer/stt-sdk
```

Node.js >= 18.18 (fetch/WebSocket globals) or any modern browser. The public entry
point uses only standard platform APIs (`fetch`, `WebSocket`, `FormData`, `Blob`);
no Node-only APIs are required.

## Quick start

### Local batch transcription (Faster Whisper runtime)

```ts
import { FasterWhisperProvider } from "@voice-typer/stt-sdk";

const provider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
const result = await provider.transcribe({ file, filename: "recording.webm", prompt: "context" });
console.log(result.text); // -> { text: "..." } preserved from the runtime
```

### Local streaming (protocol v1)

```ts
import { FasterWhisperProvider } from "@voice-typer/stt-sdk";

const provider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
const session = await provider.createStream({
  language: "en",
  model: "auto",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
});
session.onEvent = (event) => console.log(event.type, event);
session.sendAudio(pcmBytes); // raw int16 little-endian PCM
await session.stop();        // flushes final, server sends closed
```

### Cloud (Deepgram) — no server required

```ts
import { DeepgramProvider } from "@voice-typer/stt-sdk";

const provider = new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! });
const result = await provider.transcribe({ file, filename: "recording.webm" });
const session = await provider.createStream({
  language: "en",
  model: "nova-2",
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
});
```

### From a server-issued runtime descriptor

```ts
import { createProvider } from "@voice-typer/stt-sdk";

// descriptor: RuntimeConnectionDescriptor issued by stt-server for a local runtime
const provider = createProvider(descriptor);
```

## Public API

- **Provider interface** — `SttProvider` with `id`, `info`, `listModels()`,
  `transcribe()`, `createStream()`. Local and cloud adapters expose the same contract.
- **Capabilities** — `ProviderInfo` / `ProviderCapability` normalized across adapters.
- **Runtime descriptors** — `RuntimeConnectionDescriptor` (versioned, server-issued).
- **Models** — `ModelInfo`.
- **Batch** — `BatchTranscriptionRequest`, `TranscriptionResult`, `TranscriptionSegment`.
- **Streaming** — `StreamConfig`, `StreamSession`, `SessionState`, and protocol-v1
  `TranscriptEvent` union (`ready`, `partial`, `final`, `lagging`, `error`, `closed`).
- **Timestamps** — `TranscriptWord` with `startMs`/`endMs`/`probability`.
- **Errors** — `SttError` hierarchy with machine `code` and `retryable` flags;
  `UnsupportedCapabilityError` marks explicit adapter seams.

## Adapters

| Adapter | Status | Transport |
|---|---|---|
| `FasterWhisperProvider` | implemented | HTTP batch (`POST /v1/audio/transcriptions`) + WS stream (`WS /v1/audio/stream`) |
| `DeepgramProvider` | implemented (cloud proof) | REST `POST /v1/listen` + WS `wss://api.deepgram.com/v1/listen` |
| `WhisperCppProvider` | seam (typed, not implemented) | — |
| `OpenAIProvider` | seam (typed, not implemented) | — |
| `GroqProvider` | seam (typed, not implemented) | — |

Seam adapters are named public entry points. Constructing them succeeds and reports
provider info; `transcribe`/`createStream`/`listModels` throw
`UnsupportedCapabilityError` so unimplemented behavior is explicit and typed.

## Delivery decisions (2026-08-12)

- **Package name / versioning**: `@voice-typer/stt-sdk` v0.1.0, independently
  versioned with semantic versioning. `0.x` is initial development; compatibility is
  preserved within a major version per `CONVENTIONS.md`. Publishing to a registry
  requires the `@voice-typer` npm org and publish credentials (not configured yet).
- **Cloud proof**: **Deepgram** is the first cloud adapter contract proof. It was
  chosen because the Voice Typer protocol already maps Deepgram semantics
  (`is_final` false/true → `partial`/`final`), it offers batch + streaming parallel
  to the local contract, and it is verifiable with fixtures without a server or
  credentials. OpenAI and Groq remain typed seams.
- **Browser/Node compatibility**: the public entry point is isomorphic — standard
  `fetch`/`WebSocket`/`FormData`/`Blob` only. No Node-only APIs in `src/`.

## Protocol preservation

- Batch: multipart `POST /v1/audio/transcriptions` with `file` + optional `prompt`;
  response `{ text }` — the OpenDora-compatible contract.
- Stream: `WS /v1/audio/stream`, `start` (protocolVersion 1) → `ready` → binary PCM →
  `partial`/`final`/`lagging`/`error` → `stop`/`abort` → `closed`. Unknown event
  types and unknown fields are tolerated; events are forwarded to `onEvent`.
- The streaming client buffers audio until the server confirms `ready`, exactly like
  the historical App provider.

## Non-goals

- No hardware detection, provider install/update/removal, model download, runtime
  start/stop/health supervision, or recommendations (those are `stt-server`).
- No new provider services or changes to existing runtime endpoints/events.
- No App UX or Server control-plane implementation.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify:consumer   # pack + install into a blank consumer fixture + typecheck
```

## Reconcile note

Historical contract sources (`whisper-vibes/packages/shared`,
`whisper-vibes/apps/web/src/lib/api.ts`, `whisper-vibes/apps/web/src/providers/voice-typer-ws-provider.ts`,
`stt-server/sdk`) are legacy duplicates. Their owning repositories must migrate to
consume this published package and remove the duplicated contract source; this
repository does not import from them by path, workspace link, or copy.
