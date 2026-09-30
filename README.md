# @open-vibe-ai/stt-sdk

Voice Typer provider-communication library. One normalized TypeScript interface for
local STT runtime endpoints (Faster Whisper, Whisper.cpp) and cloud STT APIs
(Deepgram, OpenAI, Groq) — without taking on server lifecycle responsibilities.

This package is the **sole public provider contract** for the Voice Typer product.
It is independently versioned and published; it never depends on `stt-server` and
contains no hardware detection, installation, model lifecycle, process supervision,
or inference.

## Install

```bash
npm install @open-vibe-ai/stt-sdk
```

Node.js >= 18.18 (fetch/WebSocket globals) or any modern browser. The public entry
point uses only standard platform APIs (`fetch`, `WebSocket`, `FormData`, `Blob`);
no Node-only APIs are required.

## Quick start

### Local batch transcription (Faster Whisper runtime)

```ts
import { FasterWhisperProvider } from "@open-vibe-ai/stt-sdk";

const provider = new FasterWhisperProvider({ baseUrl: "http://127.0.0.1:8000" });
const result = await provider.transcribe({ file, filename: "recording.webm", prompt: "context" });
console.log(result.text); // -> { text: "..." } preserved from the runtime
```

`FasterWhisperProvider` is batch-only — it previously also implemented a local
`WS /v1/audio/stream` streaming session (`createStream()`), removed once it
became clear it was never actually the source of committed/pasted text, only
a preview overlay (see `providers/faster-whisper.ts`'s class doc comment).
`createStream()` now throws `UnsupportedCapabilityError`, matching
`WhisperCppProvider`/`OpenAIProvider`/`GroqProvider` below. For real
streaming, see the Deepgram example next.

### Cloud (Deepgram) — no server required

```ts
import { DeepgramProvider } from "@open-vibe-ai/stt-sdk";

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

### stt-server-next — used exactly like a cloud provider

```ts
import { SttServerNextProvider } from "@open-vibe-ai/stt-sdk";

const provider = new SttServerNextProvider({
  baseUrl: "http://127.0.0.1:54321", // app discovers this; the SDK does no discovery
  token: authToken,                  // from <data-dir>/auth.token or user.token
});

const models = await provider.listModels(); // callable models only, each with capabilities + isDefault

const result = await provider.transcribe({
  file,
  filename: "recording.wav",
  model: "whisper-tiny",   // omit to use the server's default model
  prompt: "vocabulary hint",
  language: "en",
  temperature: 0.2,
  wordTimestamps: true,
});

// Translation to English, where the chosen model supports it:
const translated = await provider.translate({ file, model: "whisper-tiny" });
```

`SttServerNextProvider` connects with an address and a token like a cloud provider —
no discovery, install, model management, or server lifecycle. It checks `GET /health`
on first use and refuses clearly if the server isn't `stt-server-next` or its
`api_level` is too old. Before sending `prompt`/`language`/`temperature`/timestamp
fields, it checks the chosen model's capabilities (from `GET /v1/models`, cached and
refreshed on a stale-capability error) and omits anything the model doesn't support —
an `"unknown"` capability status is treated the same as unsupported. Server errors are
mapped to a stable `code`/`retryable` hierarchy (`ServerNotReadyError`,
`ModelLoadingError` (retryable), `ModelNotInstalledError`,
`ServerUnsupportedCapabilityError`, `ServerBusyError` (retryable),
`AdminRequiredError`, `UnauthorizedError`, `NetworkNotPrivateError`,
`ServerVersionError`); an unrecognized server error code still surfaces with its
original `code` rather than being swallowed.

### From a server-issued runtime descriptor

```ts
import { createProvider } from "@open-vibe-ai/stt-sdk";

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
| `FasterWhisperProvider` | implemented (batch-only) | HTTP batch (`POST /v1/audio/transcriptions`) |
| `DeepgramProvider` | implemented (cloud proof) | REST `POST /v1/listen` + WS `wss://api.deepgram.com/v1/listen` |
| `WhisperCppProvider` | seam (typed, not implemented) | — |
| `OpenAIProvider` | seam (typed, not implemented) | — |
| `GroqProvider` | seam (typed, not implemented) | — |
| `SttServerNextProvider` | implemented | HTTP batch (`POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, `GET /v1/models`, `GET /health`) |

Seam adapters are named public entry points. Constructing them succeeds and reports
provider info; `transcribe`/`createStream`/`listModels` throw
`UnsupportedCapabilityError` so unimplemented behavior is explicit and typed.

## Delivery decisions (2026-08-12)

- **Package name / versioning**: `@open-vibe-ai/stt-sdk`, independently
  versioned with semantic versioning and published to npm from the tag-triggered
  `release.yml` via OIDC trusted publishing (no npm token). `0.x` is initial development;
  compatibility is preserved within a major version per `CONVENTIONS.md`.
- **Cloud proof**: **Deepgram** is the first cloud adapter contract proof. It was
  chosen because the Voice Typer protocol already maps Deepgram semantics
  (`is_final` false/true → `partial`/`final`), it offers batch + streaming parallel
  to the local contract, and it is verifiable with fixtures without a server or
  credentials. OpenAI and Groq remain typed seams.
- **Browser/Node compatibility**: the public entry point is isomorphic — standard
  `fetch`/`WebSocket`/`FormData`/`Blob` only. No Node-only APIs in `src/`.

## Protocol preservation

- Batch: multipart `POST /v1/audio/transcriptions` with `file` + optional `prompt`;
  response `{ text }` (additively including `language`/`duration`/`segments` when the
  runtime sends them) — the OpenDora-compatible contract.
- `FasterWhisperProvider` no longer implements the local `WS /v1/audio/stream`
  protocol — see "Adapters" above. Deepgram's own streaming protocol (`wss://
  api.deepgram.com/v1/listen`) is unaffected; unknown event types/fields there are
  still tolerated and forwarded to `onEvent`, and its client still buffers audio
  until the server confirms readiness.

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
`whisper-vibes/apps/web/src/lib/api.ts`, `stt-server/sdk`) are legacy duplicates.
Their owning repositories must migrate to consume this published package and
remove the duplicated contract source; this repository does not import from
them by path, workspace link, or copy.

`whisper-vibes/apps/web/src/providers/voice-typer-ws-provider.ts` no longer
exists — it implemented the local WS streaming engine, which was removed
(along with this SDK's own `FasterWhisperProvider.createStream()`) once it
became clear it was never actually the source of committed/pasted text, only
a preview overlay. See this package's own `providers/faster-whisper.ts` class
doc comment.
