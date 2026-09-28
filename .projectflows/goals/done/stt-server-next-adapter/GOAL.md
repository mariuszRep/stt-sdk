---
name: stt-server-next-adapter
title: Use STT Server Next Like Any Cloud Provider
description: Add an stt-server-next provider to the SDK that behaves exactly like a cloud speech provider — connect with an address and token, list callable models, transcribe and translate — so apps switch without rewriting their transcription code.
status: done
type: feature
scope: stt-sdk only
attempt: 1
max_attempts: 8
last_result: passed
next_action: none
success_criteria:
  - An app creates the provider from an address and a token, the same way it creates a cloud provider, and transcribes through the same SDK call it uses today.
  - Listing models returns only the models the server can use right now, each with its capabilities and which one is the default.
  - Each request can name the model to use; the SDK never selects, loads, downloads or removes models.
  - The SDK only sends options the chosen model supports, so users never see errors caused by unsupported options.
  - Translation to English is available for models that support it.
  - Failures come back as clear, structured errors, and a server that is too old is reported clearly.
  - The existing provider-based adapter keeps working unchanged until the app has switched.
source: user
---

# Use STT Server Next Like Any Cloud Provider

## Why

Voice Typer talks to its speech engines through this SDK, and the SDK treats every engine the
same way: something you connect to and call. The new server is used exactly like a cloud
provider such as OpenAI: models are simply available to call, and managing them is not the
SDK's job.

## Business rules

- **Same as a cloud provider.** Connect with an address and a token (the app finds these; the SDK
  does no discovery). No installing, downloading, progress, selecting, removing, refreshing, or
  starting and stopping servers — exactly as with OpenAI.
- **Models.** Listing returns the models that can be called now, with their capabilities
  (prompt, language hint, translation, temperature, timestamps) and which one is the default.
  Each request may name a model; with none, the server's default is used.
- **Never send what won't work.** Before sending a prompt, language, temperature or timestamp
  request, the SDK checks what the chosen model supports and leaves out anything it doesn't. The
  app's saved settings stay untouched. The prompt, including vocabulary words, is built by the
  app and passed through as-is.
- **Translation.** Apps can ask for English text from speech in another language, where the chosen
  model supports it.
- **Clear errors.** Server not ready, model loading, model not installed, option unsupported, busy
  (can retry) and admin access required come back as structured errors the app can explain.
- **Version check.** The SDK reads the server's version and API level and refuses clearly when the
  server is too old.
- **No disruption.** The existing adapter for the old server stays available and unchanged until
  the app has switched and the old server is retired.

## Out of scope

Model management and discovery (the app does these through the server's model manager), app UI,
server changes, streaming.

## Related goals

- Workspace: `voice-typer/.projectflows/goals/in_progress/migrate-voice-typer-to-stt-server-next`.
- `stt-server-next`: `ready/openai-model-per-request` (the per-request model and `/v1/models`
  this adapter uses) and `docs/client-contract.md`.
- `whisper-vibes`: `draft/switch-to-stt-server-next`.

## Attempts

**Attempt 1 (2026-09-28): implemented and verified.**

- New `SttServerNextProvider` (`src/providers/stt-server-next.ts`), constructed
  `new SttServerNextProvider({ baseUrl, token }, deps?)` exactly like the cloud providers, with
  `TransportDeps` (`fetchImpl`) for test injection. Exported from `src/providers/index.ts` and
  `src/index.ts`.
- `listModels()` — `GET /v1/models`, mapped to `ModelInfo[]` with new optional `isDefault` and
  `capabilities` fields (backwards compatible — both optional, existing adapters unaffected).
  Capability-gating rule (documented in code and README): a control counts as supported only when
  the server's status is exactly `"supported"`; `"unknown"` and `"unsupported"` both map to `false`
  — the SDK never sends an optional field it cannot confirm the model accepts.
- `transcribe()` — multipart `POST /v1/audio/transcriptions`; `model` sent only when given
  (otherwise omitted so the server's default resolves); `prompt` (verbatim), `language`,
  `temperature`, and timestamp fields (`response_format=verbose_json` +
  `timestamp_granularities`) are only sent when the resolved model's capabilities say
  `"supported"`. Capabilities are fetched from `/v1/models` and cached; on a
  `model_not_installed`/`unsupported_capability` response the cache is refreshed and the request
  retried once.
- `translate()` — new optional `SttProvider.translate?` method (added to `src/provider.ts` as
  optional so other providers are unaffected) — `POST /v1/audio/translations`; throws
  `UnsupportedCapabilityError` up front if the resolved model's capabilities don't report
  translation as supported.
- Version check — `GET /health` on first use; requires `service === "stt-server-next"` and
  `api_level >= 1` (`MIN_API_LEVEL` constant in the provider); throws `ServerVersionError` with
  code `not_stt_server_next` (wrong/missing service, bad JSON, non-2xx) or `server_too_old`
  (insufficient `api_level`).
- Errors — `src/errors.ts` gained `ServerError` (base) and coded subclasses parsed from the
  server's `{"error":{"code","message","details"}}` envelope:

  | Server code | SDK class | retryable |
  |---|---|---|
  | `server_not_ready` | `ServerNotReadyError` | false |
  | `model_loading` | `ModelLoadingError` | true |
  | `model_not_installed` | `ModelNotInstalledError` | false |
  | `unsupported_capability` | `ServerUnsupportedCapabilityError` | false |
  | `queue_full` / `engine_busy` | `ServerBusyError` | true |
  | `admin_required` | `AdminRequiredError` | false |
  | `unauthorized` | `UnauthorizedError` | false |
  | `network_not_private` | `NetworkNotPrivateError` | false |
  | anything else | `ServerError` with the server's own `code` | false |

  A network/transport failure (fetch throwing) still maps to the existing `ConnectionError`.
- No model management, discovery, install/download/select/remove, or server lifecycle code was
  added — the provider only calls `GET /health`, `GET /v1/models`,
  `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`.
- `LocalRuntimeProvider`, `factory.ts`, and all pre-existing tests are unchanged and still pass.
- Tests: `test/stt-server-next.test.ts` (21 cases — version check pass/fail/network-error,
  `listModels` mapping incl. the `"unknown"`-is-not-supported rule, capability gating (prompt/
  language/temperature/timestamps sent vs. dropped), model-per-request, response mapping
  (segments/words/diagnostics), `translate` success + `UnsupportedCapabilityError`, and every
  error-code mapping with its `retryable` flag). `test/stt-server-next.contract.test.ts` — optional,
  skipped unless `STT_NEXT_URL`/`STT_NEXT_TOKEN` are set; hits a real server for `listModels`,
  `transcribe` (tiny generated WAV), `translate`, and a bad-model → `ModelNotInstalledError` case.
- Docs: added a "stt-server-next" README usage section and an `SttServerNextProvider` row to the
  Adapters table; no `CHANGELOG` file exists in this repo, so none was added. `package.json` bumped
  to `0.3.0` (not published).
- Goal file moved `draft` → `in_progress` → `done` (`git mv`, uncommitted per instructions — no
  commit/push was made).

### Gate results

- `npm run typecheck` — pass.
- `npm test` — 54 passed, 4 skipped (the optional contract file, skipped when env vars are unset).
- `npm run build` — pass (ESM + CJS + `.d.ts`).
- `npm run verify:consumer` — pass (tarball audit clean: no `src/`, `test/`, `scripts/`,
  `.projectflows`, env, or credential files; ESM + CJS consumer typecheck passed).

### Contract test against a real server

Spawned `stt-server-next.exe run --port 54460 --data-dir <temp>`, confirmed `/health` reported
`service: "stt-server-next"`, `api_level: 1`; ran `models download whisper-tiny --wait` (completed,
45,981,088 bytes) and `models default whisper-tiny` (loaded on `Vulkan0`, no fallback); read the
token from `<temp>\auth.token`; ran
`STT_NEXT_URL=http://127.0.0.1:54460 STT_NEXT_TOKEN=<token> npx vitest run
test/stt-server-next.contract.test.ts` — **4/4 passed**: `listModels` returned whisper-tiny as
default, `transcribe` on a generated tiny WAV returned text, `translate`/unsupported-model branch
resolved correctly, and an unknown model id raised `ModelNotInstalledError`. Then
`stt-server-next.exe stop --data-dir <temp>` (confirmed `/health` no longer reachable) and deleted
the temp data dir. Server/download/stop logs were kept under
`C:\Users\mariu\AppData\Local\Temp\claude\scratch-sdk\*.log` during the run.

## Verification Log

2026-09-26: Drafted from the migration plan (phase 3).
2026-09-28: Rewritten to the user's cloud-provider scope: the SDK lists callable models and
transcribes/translates with a model per request; model management and discovery stay in the app.
2026-09-28: Implemented, tested (unit + real-server contract test), and all verify gates
(typecheck/test/build/verify:consumer) passed. Moved to `done`.

## Final Outcome

Success. `SttServerNextProvider` is implemented, exported, documented, and verified against both
mocked and real `stt-server-next` instances. All success criteria are met:
- Constructed from an address + token like a cloud provider; `transcribe`/`listModels` are the
  same SDK calls apps already use.
- `listModels()` returns only callable models, each with capabilities and an `isDefault` flag.
- `model` is per-request; the SDK never selects, loads, downloads, or removes models.
- Unsupported options are never sent — verified by capability-gating tests and the derivation rule
  (`"unknown"` treated as unsupported).
- `translate()` is available and gated on the model's `translation` capability.
- Failures map to a stable, documented error-code table; a too-old/wrong server is reported via
  `ServerVersionError`.
- `LocalRuntimeProvider`/`FasterWhisperProvider`/etc. and existing tests are byte-for-byte
  unchanged and still pass.
