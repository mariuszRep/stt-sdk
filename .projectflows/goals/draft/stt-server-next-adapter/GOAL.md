---
name: stt-server-next-adapter
title: Use STT Server Next Like Any Cloud Provider
description: Add an stt-server-next provider to the SDK that behaves exactly like a cloud speech provider — connect with an address and token, list callable models, transcribe and translate — so apps switch without rewriting their transcription code.
status: draft
type: feature
scope: stt-sdk only
attempt: 0
max_attempts: 8
last_result: none
next_action: Review with the user, then move to ready. Depends on stt-server-next goal openai-model-per-request.
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

None yet.

## Verification Log

2026-09-26: Drafted from the migration plan (phase 3).
2026-09-28: Rewritten to the user's cloud-provider scope: the SDK lists callable models and
transcribes/translates with a model per request; model management and discovery stay in the app.

## Final Outcome

Not started.
