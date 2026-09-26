---
name: stt-server-next-adapter
title: Connect the STT SDK to STT Server Next
description: Give SDK users a way to talk to the new single-engine speech server, alongside the existing provider adapter, so apps can switch without rewriting their transcription code.
status: draft
type: feature
scope: stt-sdk only
attempt: 0
max_attempts: 8
last_result: none
next_action: Review with the user, then move to ready.
success_criteria:
  - An app using the SDK can find a running stt-server-next, connect with its token, and transcribe audio through the same SDK transcription call it uses today.
  - The SDK only sends options the selected model actually supports, so users never see errors caused by unsupported options.
  - Apps can list, recommend, install, select, and remove models, and follow download progress, through the SDK.
  - Translation to English is available for models that support it.
  - The existing provider-based adapter keeps working unchanged until the app has switched.
source: user
---

# Connect the STT SDK to STT Server Next

## Why

Voice Typer talks to its speech server through this SDK. The new server works differently: one
server with one set of models instead of separate providers, each with its own connection
details. The SDK needs a way to work with it so the app can switch over by changing its
setup, not its transcription code.

## Business rules

- **Finding the server.** Whether the app started the server itself or the user runs it on
  their own, the SDK can locate it and connect securely with its token.
- **Same transcription call.** Apps keep calling transcription the way they do today. The SDK
  translates that into the new server's request and returns the same kind of result, with the
  extra details (language used, timing, diagnostics) available when the app wants them.
- **Never send what won't work.** Before sending a prompt, language, temperature, or timestamp
  request, the SDK checks what the selected model supports and leaves out anything it doesn't.
  The app's saved settings stay untouched; they simply apply again when a capable model is
  selected. The prompt, including any vocabulary words, is built by the app and passed through
  as-is.
- **Models, not providers.** Apps work with a list of models: recommendations, installed
  models, download progress, selection, and removal. There are no providers to start or stop.
- **Translation.** Apps can ask for English text from speech in another language, where the
  selected model supports it.
- **Clear errors.** Failures come back as understandable, structured errors (server not ready,
  model not installed, option unsupported, busy) so the app can explain them to the user.
- **No disruption.** The existing adapter for the old server stays available and unchanged
  until the app has fully switched and the old server is retired.

## Out of scope

App UI changes (whisper-vibes goal), server changes (stt-server-next goal), streaming.

## Related goals

- Workspace: `voice-typer/.projectflows/goals/in_progress/migrate-voice-typer-to-stt-server-next`
  (the server's client contract is described there and in `stt-server-next/docs/client-contract.md`).
- `stt-server-next`: `draft/ready-for-voice-typer`.
- `whisper-vibes`: `draft/switch-to-stt-server-next`.

## Attempts

None yet.

## Verification Log

2026-09-26: Drafted from the migration plan (phase 3).

## Final Outcome

Not started.
