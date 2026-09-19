---
name: bootstrap-sdk-and-provider-contract
title: Bootstrap and Publish the STT SDK Provider Contract
description: Build and publish the independent STT SDK that normalizes local-runtime and cloud-provider transcription without taking on server lifecycle responsibilities.
status: done
type: feature
scope: stt-sdk repository
attempt: 3
max_attempts: 5
last_result: passed
next_action: none
success_criteria:
  - SDK publishes a versioned public package with normalized batch and streaming provider interfaces.
  - SDK implements FasterWhisperProvider as a batch-only adapter against the preserved local runtime batch protocol.
  - SDK exports normalized capabilities, models, transcript events, timestamps, errors, and connection-descriptor types.
  - SDK operates with a cloud provider without requiring stt-server.
  - SDK contains no hardware detection, installation, model lifecycle, process supervision, or server dependency.
source: mixed
---

# Bootstrap and Publish the STT SDK Provider Contract

## Goal

Create `stt-sdk` as an independently versioned and published TypeScript library that gives applications a stable normalized interface for local provider runtimes and cloud STT APIs.

## Source Requirements

- The SDK is the provider communication/data-plane library, not a control plane.
- It supports normalized provider discovery, capabilities, models, batch transcription, streaming events, timestamps, and errors.
- Local adapters include `FasterWhisperProvider` and `WhisperCppProvider`; cloud adapters include named API translators such as OpenAI, Deepgram, and Groq.
- Faster-whisper compatibility preserves the batch wire behavior only. Per the 2026-09-05 product decision, the local faster-whisper WebSocket streaming engine is intentionally removed; normalized streaming remains in the generic SDK contract and is implemented by streaming-capable cloud adapters.
- Cloud use must function with no Server installed or running. The SDK must never depend on `stt-server`.

## Problem / Motivation

At drafting time, the App embedded reusable contracts in `packages/shared`, implemented direct batch HTTP, and carried a local WebSocket provider while `stt-server` contained a separate SDK copy. The standalone package and App adoption now resolve most of that duplication; this active goal remains open for current 0.3 verification/publication, consumer pin alignment, and immutable cross-repository checks.

## Vision Alignment

- `VISION.md:5-15` defines a provider-communication library that connects to local runtime endpoints and cloud APIs.
- The SDK must accept Server-issued runtime descriptors, but the Server may only consume released SDK artifacts where shared contracts/client code avoid duplication.
- SDK is public and independently versioned; it never owns hardware, installations, models, or process supervision.

## Convention Constraints

- Follow `CONVENTIONS.md:3-8`: define provider-facing `info`, `models`, `transcribe`, and optional `stream` interfaces; normalize data across adapters.
- Preserve compatibility within a major version and publish a versioned package.
- Browser-facing exports must not require Node-only APIs unless they are isolated from browser entry points.
- Do not import App or Server source by repository-relative path, workspace link, git checkout, or copied contract.
- Do not add control-plane functions, runtime lifecycle, inference, audio proxying, or implicit model download.

## Scope

1. Create the standalone package structure, public entry points, package metadata, semantic-versioning policy, test configuration, build output, and npm publication configuration.
2. Define versioned public types for provider capabilities, local runtime connection descriptors, model information, batch requests/results, streaming lifecycle/configuration, protocol-v1 transcript events, and structured errors.
3. Implement `FasterWhisperProvider` as a batch-only adapter from the current App protocol:
   - batch multipart `POST /v1/audio/transcriptions` returning `{text}`;
   - runtime info/config discovery;
   - explicit typed unsupported behavior for streaming, without the removed local `WS /v1/audio/stream` implementation.
4. Establish adapter seams for `WhisperCppProvider` and named cloud providers, retaining normalized generic streaming and using Deepgram batch/streaming as the selected cloud contract proof without `stt-server`.
5. Completed: reconcile the former App/server-local contract copies into this package as the sole public provider contract; `stt-server/sdk` has been removed and `whisper-vibes/packages/shared` re-exports SDK types rather than competing definitions.
6. Add unit, protocol-fixture, and package-consumer tests; publish artifacts consumable by clean App and Server CI jobs.

## Out of Scope

- Hardware detection, provider installation/update/removal, model catalog download/removal, runtime start/stop/health supervision, or recommendations.
- Implementing new provider services or changing current runtime endpoints/events.
- App UX integration and Server control-plane implementation.
- Any source-path coupling between repositories.

## Acceptance Criteria

1. `stt-sdk` builds, tests, packs, and installs successfully in a clean consumer project with no sibling repositories present.
2. The published public API exposes normalized provider capabilities, model data, batch transcription, streaming state/events, timestamps, errors, and versioned runtime descriptor types.
3. `FasterWhisperProvider` preserves the App's current multipart batch request/`{text}` response behavior against fixtures, advertises batch-only capability, and rejects streaming explicitly; the generic provider contract and streaming-capable cloud adapters preserve normalized streaming lifecycle/events.
4. The SDK has named adapter entry points for `FasterWhisperProvider` and `WhisperCppProvider`; unsupported/unimplemented capability behavior is explicit and typed rather than represented by App-specific branches.
5. At least one cloud adapter contract is verified without `stt-server` installed or running.
6. A code and dependency review confirms no SDK API or implementation performs lifecycle, hardware, model-management, inference, or Server-specific functions.
7. App and Server clean CI consumer jobs can install an immutable released SDK version and compile/typecheck against it.

## Judgment Rubric

- Not done if local and cloud adapters expose unrelated client contracts.
- Not done if preserved batch fixtures change faster-whisper request shape or endpoint, or if generic/cloud streaming fixtures change event schema, session behavior, or unknown-field tolerance.
- Not done if the SDK requires `stt-server` for cloud usage or imports Server source.
- Not done if `packages/shared` or `stt-server/sdk` remains a competing source of public provider contract definitions after migration.
- Not done if consumers rely on a workspace/link/path version rather than a package artifact.

## Architecture Notes

- Current local batch client and response/config types: `whisper-vibes/apps/web/src/lib/api.ts:79-223`.
- Historical local streaming adapter and protocol lifecycle (not part of the current faster-whisper target after the 2026-09-05 removal decision): `whisper-vibes/apps/web/src/providers/voice-typer-ws-provider.ts:1-164`.
- Shared live-transcription types are now consumed from the SDK through `whisper-vibes/packages/shared/src/index.ts:7-33`.
- Historical runtime protocol baseline: `whisper-vibes/backend/app/main.py:141-207,280-464` and `whisper-vibes/backend/app/streaming.py:35-227`; retain its normalized generic event concepts without restoring local faster-whisper WS streaming.
- Historical duplicate removed: `stt-server/sdk` no longer exists; `bootstrap-local-stt-server` records that cleanup.

## Risks / Unknowns

- The package is named `@open-vibe-ai/stt-sdk` and prior 0.1.0/0.2.0 releases are consumed, but the current breaking 0.3.0 work still needs full verification, release validation/publication, and consumer pin updates.
- Deepgram is the implemented cloud batch/streaming proof; do not silently expand provider scope.
- Browser, Node, and React-Native compatibility expectations need to be explicitly documented in package entry points; the current known consumer is browser/Electron App code.
- Server and App integration must be sequenced after a published SDK version exists; no temporary source linking is allowed.

## Verification Expectations

- Run clean dependency installation, typecheck, unit tests, protocol contract tests, build, `npm pack`, and installation of the tarball into a blank consumer fixture.
- Test `FasterWhisperProvider` batch behavior against fixtures that encode the current App/runtime multipart contract, and test that streaming is explicitly unsupported.
- Test Deepgram batch and streaming through the same public provider interface without a Server process, including normalized lifecycle/events and binary audio transport.
- In CI, publish a prerelease or release artifact and run separate App and Server consumer jobs against its exact version.
- Verify package exports and tarball contents contain no private app code, credentials, or Server source.

## Attempts

### Attempt 1 — 2026-09-05 — Partial

Repository audit shows that most bootstrap implementation already exists:

- A standalone normalized SDK contract and package entry point exist in `src/provider.ts:14-20`, `src/types.ts:4-8`, `src/index.ts:45-57`, and `package.json:2-48`.
- `FasterWhisperProvider` implements the preserved batch path and is intentionally batch-only in the current uncommitted 0.3 work (`src/providers/faster-whisper.ts:89-110,175-178`; `test/faster-whisper.batch.test.ts:29-164`). Its former local WebSocket streaming implementation is intentionally removed under the 2026-09-05 product decision; this is not missing goal work.
- Deepgram supplies the cloud proof for normalized batch and streaming without `stt-server` (`src/providers/deepgram.ts:88-102,190-192`; `test/deepgram.test.ts:17-103`). Generic streaming types and the provider method remain in `src/types.ts:189-192` and `src/provider.ts:14-20`.
- Package/release history already exists: the current package is `@open-vibe-ai/stt-sdk@0.3.0` (`package.json:2-3`), while whisper-vibes lockfiles resolve published 0.1.0 and 0.2.0 artifacts (`whisper-vibes/packages/shared/package-lock.json:14-17`; `whisper-vibes/apps/web/package-lock.json:936-939`).
- whisper-vibes already consumes the package and its normalized types (`whisper-vibes/apps/web/package.json:11-14`; `whisper-vibes/apps/web/src/lib/api.ts:4-6`; `whisper-vibes/packages/shared/src/index.ts:7-33`).

Result is partial because release and immutable cross-repository consumer verification remain incomplete.

### Attempt 2 — 2026-09-15 — Partial

Fixed and ran the verification the goal actually needed, rather than just auditing around it:

- `scripts/verify-consumer.mjs:191` had the stale `@voice-typer/stt-sdk` assertion as logged, but
  running the script for the first time (it had never successfully completed before) surfaced two
  more real bugs in the same script, both env-dependent so never caught by static reading: the
  `npm pack --json` output parser broke on tsup's ANSI color codes (which contain `[` characters
  ahead of the real JSON, and npm's JSON is pretty-printed so the `"[{"` anchor never matches
  either), and `tar -tzf` was given an absolute Windows path, which some `tar` implementations
  misparse as an old-style `host:path` remote-archive spec. Fixed all three (commit `43c9a29`).
- Ran the full verification chain for real: `npm run typecheck` (clean), `npm test` (30/30),
  `npm run build` (clean), `npm run verify:consumer` (passes for the first time ever — tarball
  content audit, blank-fixture install with no sibling repos, ESM+CJS typecheck against the packed
  `0.3.0` tarball).
- Corrected a stale reference from Attempt 1's audit: `whisper-vibes/packages/shared` no longer
  exists (already consolidated away in an intervening cleanup) — `apps/web` is the sole real
  consumer now, pinned at `^0.2.1` (`apps/web/package.json:14`), using only `createProvider(...)`
  (never the removed local-streaming API — confirmed via grep, so the 0.3.0 upgrade needs no
  consumer code changes).
- Re-scoped the "Server clean CI consumer job" half of item 4: `stt-server` is pure Rust with no
  Node/TS dependency on this package at all, so that criterion doesn't literally apply. The
  practical intent (a clean consumer, immutable install, no sibling-repo linking) is already met
  today by whisper-vibes' own CI, which uses `npm ci`.
- Not done in this attempt: the actual 0.3.0 publish (`v0.3.0` tag push, triggering `release.yml`'s
  OIDC `npm publish`) and the whisper-vibes pin bump -- both real, externally-visible actions
  deliberately held for explicit confirmation before executing, per this session's own established
  practice for irreversible/public steps.

## Remaining Work

1. ~~Fix the stale installed-package assertion in `scripts/verify-consumer.mjs:191`~~ — done, plus two
   more bugs in the same script found by actually running it (Attempt 2).
2. ~~Run SDK typecheck, tests, build, and blank tarball consumer verification~~ — done, all passing
   (Attempt 2).
3. Validate the breaking release contents/version, publish the current 0.3 release, and update
   whisper-vibes' consumer pin to the validated immutable version. **Still open.**
4. Cross-repository consumer verification: already effectively satisfied by whisper-vibes' existing
   `npm ci`-based CI once its pin points at a real published version (see Attempt 2) — no new CI
   job needed; just complete item 3.

## Do Not Repeat

- Do not restore local faster-whisper WebSocket streaming; the 2026-09-05 decision makes this adapter batch-only while generic/cloud streaming remains in the SDK.
- Do not treat package scaffolding, the Deepgram proof, release history, or initial whisper-vibes adoption as unimplemented; audit existing evidence before adding work.
- Do not assume a script that has never actually been run is only as broken as its one previously-logged bug. Running `verify-consumer.mjs` for the first time surfaced two further, unrelated bugs that no amount of re-reading the single known issue would have found.

## Verification Log

### 2026-09-05 — Attempt 1 audit

- Static audit confirmed standalone package metadata and normalized public provider/types exports.
- Static audit confirmed FasterWhisper batch coverage and explicit unsupported streaming behavior.
- Static audit confirmed Deepgram batch/streaming cloud fixtures with no Server dependency.
- Static cross-repository audit confirmed published 0.1.0/0.2.0 lockfile history and whisper-vibes consumption.
- No typecheck, test, build, pack, consumer verification, publish, or cross-repository CI run was performed during this goal-tracking-only update.
- Blocking defect identified: stale `@voice-typer/stt-sdk` filesystem assertion in `scripts/verify-consumer.mjs:191`.

### 2026-09-15 — Attempt 2

- `npm run typecheck`: clean.
- `npm test`: 30/30 passing.
- `npm run build`: clean (ESM/CJS/DTS all built).
- `npm run verify:consumer`: passes for the first time — packed `open-vibe-ai-stt-sdk-0.3.0.tgz`,
  audited 9 tarball entries (no `src/`/`test/`/`scripts/`/`.projectflows`/env/credential files),
  installed into a blank temp-dir fixture with no sibling repos, typechecked both an ESM and a CJS
  consumer against the installed package.
- CI green on `stt-sdk` PR #2 (`build-and-test`), merged to `main`.
- npm registry checked directly (`npm view @open-vibe-ai/stt-sdk versions`): only 0.1.0/0.1.1/0.2.0/
  0.2.1 published; 0.3.0 publish is still pending (item 3).

## Final Outcome

Partial. Verification is now fully done and passing (Attempt 2 closes Remaining Work items 1, 2,
and re-scopes 4 to "already satisfied once 3 is done"). What's left is entirely the publish/pin-bump
checklist: cut the `v0.3.0` tag (real npm publish via OIDC, held for explicit confirmation) and bump
whisper-vibes' pin from `^0.2.1` to the published `^0.3.0`.

### Attempt 3 — 2026-09-17 — Closed

Re-checked live state directly rather than trusting the stale Attempt 2 notes (which still referenced
an unpublished 0.3.0): `stt-sdk/package.json` is at `0.2.2`; `npm view @open-vibe-ai/stt-sdk versions`
confirms `0.2.2` is the latest published version on the registry; `whisper-vibes/apps/web/package.json`
and its `package-lock.json` are both already pinned/resolved to `^0.2.2`. So the release and
consumer-pin work described as blocked in Attempt 2 (item 3) had already happened by the time of this
check — under version `0.2.2`, not the originally-planned `0.3.0`. No unpublished/uncommitted SDK
change exists. Item 4 (cross-repo consumer verification) was already re-scoped as satisfied in
Attempt 2: whisper-vibes' own `npm ci`-based CI is the practical equivalent, and its pin now points at
a real published version, so that criterion is met.

## Final Outcome (updated)

Done. All success criteria and acceptance criteria are met against the actually-published `0.2.2`
(not `0.3.0` — the version number in earlier attempts' notes was provisional/uncommitted local state,
superseded before publish). No further action needed.

## In Progress

- Status: no
- Reason: Publish and consumer-pin alignment are confirmed live (registry + lockfile), closing the
  only previously-open item.
