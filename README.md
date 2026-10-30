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

### stt-server — used exactly like a cloud provider

```ts
import { SttServerProvider } from "@open-vibe-ai/stt-sdk";

const provider = new SttServerProvider({
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

// Another target language, when the model offers it (an stt-server extension to OpenAI's English-only endpoint):
const german = await provider.translate({ file, model: "canary", targetLanguage: "de" });

// A subtitle file ("srt" or "vtt", as in OpenAI's response_format) instead of a result object: the text of the file.
// A model without segment timestamps rejects with UnsupportedCapabilityError. Works on translate() too.
const subtitles: string = await provider.transcribe({ file, model: "whisper-tiny", responseFormat: "srt" });
```

Where speech is in a finished recording (Silero VAD running in the server, no model needed; an stt-server extension,
WAV audio; live detection stays in the client):

```ts
const { segments, speechRatio, duration } = await provider.detectSpeech(file, { threshold: 0.5, minSpeechMs: 250 });
// segments: [{ start: 0.26, end: 2.94 }, ...] in seconds
```

Voice fingerprints of a finished recording (CAM++ running in the server, no model needed; an stt-server extension, WAV
audio). Each segment gets a unit-length embedding; segments under 0.5 s get `null`. Left out, `segments` come from the
server's own speech detection. The pure helpers compare embeddings of one `model` (store it beside saved profiles):

```ts
import { clusterSpeakers, cosineSimilarity, matchSpeaker } from "@open-vibe-ai/stt-sdk";

const { model, segments } = await provider.embedSpeakers(file, { segments: [{ start: 0, end: 4.2 }] });
const labels = clusterSpeakers(segments.map((s) => s.embedding), { threshold: 0.4, maxSpeakers: 4 }); // [0, 1, 0, ...]
const who = matchSpeaker(segments[0].embedding!, savedProfiles, 0.4); // { profile, similarity } or null
const alike = cosineSimilarity(a, b); // -1..1; about 0.4 and up is the same voice with this model
```

Who spoke when, decided by the server (`POST /v1/audio/diarize`, an stt-server extension; it clusters with the same
algorithm as `clusterSpeakers`). The answer has the shape of OpenAI's `diarized_json` segments, **without text**:
transcribe separately and join by time. Known voices are named by embedding (from `embedSpeakers`) or by a 2-10 s
reference clip, never both in one call:

```ts
const { segments } = await provider.diarize(file, { threshold: 0.4, maxSpeakers: 4 });
// segments: [{ type: "transcript.text.segment", id: "seg_0", start: 0, end: 2.5, speaker: "A" }, ...]
await provider.diarize(file, { knownSpeakers: [{ name: "Ann", embedding: annProfile }] }); // "Ann", "A", "B", ...
await provider.diarize(file, { knownSpeakers: [{ name: "Ann", audio: annClip }] }); // a WAV clip of Ann
```

A model's `capabilities.translationTargets` lists the languages it translates into; a translating model that does
not report a list translates into English only. `translate()` and `createStream({ targetLanguage })` reject with
`UnsupportedCapabilityError` for a target the model does not offer.

`SttServerProvider` connects with an address and a token like a cloud provider —
no discovery, install, model management, or server lifecycle. It checks `GET /health`
on first use and refuses clearly if the server isn't `stt-server` or its
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

Live transcription: a model whose `ModelInfo.capabilities.streaming` is `true` can be
streamed with `provider.createStream({ model, language, encoding: "pcm_s16le", sampleRate: 16000, channels: 1 })`,
over the server's `WS /v1/realtime?intent=transcription`. `sendAudio()` takes PCM16 mono;
`partial` events carry `committed` (final, append-only) and `tentative` (may still change)
text plus a `revision`; `stop()` commits and resolves after the `final` event. A model
that does not stream rejects with `UnsupportedCapabilityError` — fall back to `transcribe()`.
With `targetLanguage` the turns are translated instead, which needs `capabilities.translation` but not streaming: a model
that cannot stream translates the whole turn when `stop()` commits it, so the `final` event arrives without `partial`s.
The server runs one stream at a time and cannot transcribe a batch with the streaming
model meanwhile. A browser `WebSocket` cannot send the bearer header, so a webview passes
`webSocketFactory`; Node needs nothing.

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
- **Models** — `ModelInfo`; the model list with flags is the [Registry](#registry) (`/registry` subpath).
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
| `SttServerProvider` | implemented | HTTP batch (`POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, `GET /v1/models`, `GET /health`), offline speech detection (`detectSpeech()`, `POST /v1/audio/vad`), speaker embeddings (`embedSpeakers()`, `POST /v1/audio/embeddings`, with `cosineSimilarity`/`matchSpeaker`/`clusterSpeakers`), diarization (`diarize()`, `POST /v1/audio/diarize`) and live `WS /v1/realtime?intent=transcription` (`createStream()`) |

Seam adapters are named public entry points. Constructing them succeeds and reports
provider info; `transcribe`/`createStream`/`listModels` throw
`UnsupportedCapabilityError` so unimplemented behavior is explicit and typed.

## Registry

`@open-vibe-ai/stt-sdk/registry` is the model registry: ONE standard list of every model the estate uses (speech,
AI, cloud and local), in the shape of stt-server's catalog extended to every kind. It is data and adapters only; it
calls no provider. The desktop app calls cloud providers itself and keeps API keys in the user's account, so nothing
here holds a key.

```ts
import { fromOllama, fromSttServerManaged, listCloudEntries, parseModelRef, toBooleans } from "@open-vibe-ai/stt-sdk/registry";
import { SttServerManagement } from "@open-vibe-ai/stt-sdk";

const management = new SttServerManagement({ baseUrl, token: adminToken });
const { entries: speech, states } = await management.listRegistryEntries(); // stt-server's catalog + install state
const ai = fromOllama(await (await fetch("http://127.0.0.1:11434/api/tags")).json());   // + shows: { [name]: /api/show body }
const cloud = listCloudEntries();                                                         // known cloud models (Plus)
const list = [...speech, ...ai, ...cloud];

parseModelRef("llm/ollama/llama3.2");     // { kind: "llm", provider: "ollama", id: "llama3.2:latest" }
```

**An entry** (`ModelEntry`) is one model of the list. Its flags:

| Field | Values |
|---|---|
| `locality` | `local` or `cloud` (anything that leaves this computer) |
| `tasks` (several allowed) | `speech-to-text`, `text-to-text`, `vision`, `text-to-speech`, `text-embedding`, `speaker-embedding`, `voice-activity-detection`, `denoise`; always includes the task of its `kind` |
| `kind` (primary, for the reference) | `speech`, `llm`, `speaker`, `vad`, `denoise`, `tts`, `embedding` |
| `access` | `free` (local) or `plus` (every cloud model) |
| `privacy` | what leaves the computer (`audio`, `text`, `context`, `images`) and `to` which host; empty for local |
| `capabilities` | stt-server's tri-state matrix (`supported` / `unsupported` / `unknown`, with `evidence`) extended with `tools`, `thinking`, `vision`, `json_schema`, `system_role`, `context_window`, `text_streaming`, ... |

**A reference** is `kind/provider/id`, the one string a workflow stores: `speech/stt-server/parakeet-tdt-0.6b-v2`,
`speech/stt-server/custom-<slug>-<sha8>`, `llm/ollama/gemma3:4b`, `llm/openrouter/anthropic/claude-sonnet-5.5`. The id
may contain `/` and `:`; only the first two `/` separate the parts. `sttServerModelRef(slug)` and `ollamaModelRef(tag)`
map the old flat ids (an Ollama name without a tag is `:latest`).

**Adapters** turn what a source says into entries: `fromSttServerManaged` (`GET /models/manage`),
`fromSttServerV1Model` (`GET /v1/models`), `fromOllama` (`/api/tags`, each optionally with its `/api/show`) and
`fromCloudCatalog`. `toBooleans(matrix)` is the one derivation of the simple `ModelCapabilities` booleans (`unknown` is
not supported); `SttServerProvider` uses it too.

**Data**: `BUILTIN_PROVIDERS` (`data/providers.json`: Ollama and the cloud providers with endpoint, auth, quirks,
timeouts, where to get a key) and `KNOWN_CLOUD_MODELS` (`data/cloud-models.json`: a short list per provider, with
context windows and capability claims of ours as of 2026-10-30, to be refreshed as providers change; a provider that takes any model id accepts others
too). Providers: AI Ollama (local), OpenAI, Anthropic, Gemini, Groq, OpenRouter, and a template for custom
OpenAI-compatible endpoints; speech OpenAI, Groq, Deepgram.

**Schema**: `MODEL_ENTRY_SCHEMA` is the JSON Schema (draft 2020-12, `schema/model-entry.v1.json` in the source). Its
`$defs` also cover `ModelState`, `ProviderDescriptor` and the two data files, so another language can validate all of
it. Additive fields never change the version.

`SttServerManagement` (main entry) is the client for stt-server's model manager and local admin API
(`/models/manage/*`, `/v1/local/*`, `/health`, `/readiness`; admin token): list, download, verify, set default,
remove, poll operations. It moved here from the Stanzo app as `ModelManagerClient`.

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

## Migrating from 0.3.x (`stt-server-next` renamed to `stt-server`)

0.3.5 is a breaking rename; there is no deprecated alias. The server formerly called
`stt-server-next` is now `stt-server` (releases v0.3.0+).

| 0.3.4 and earlier | 0.3.5 |
|---|---|
| `SttServerNextProvider` | `SttServerProvider` |
| `SttServerNextProviderOptions` | `SttServerProviderOptions` |
| provider id / capability id `"stt-server-next"` | `"stt-server"` |
| capability `displayName` `"STT Server Next"` | `"STT Server"` |
| `ServerVersionError` code `"not_stt_server_next"` | `"not_stt_server"` |

Consumers that persisted the provider id (settings, history) must migrate
`"stt-server-next"` to `"stt-server"`. `/health` must now report `service: "stt-server"`;
servers older than 0.3.0 that report `stt-server-next` are rejected with `not_stt_server`.

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
