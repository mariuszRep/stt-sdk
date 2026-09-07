---
name: bootstrap-sdk-and-provider-contract
title: Bootstrap and Publish the STT SDK Provider Contract
description: Build and publish the independent STT SDK that normalizes local-runtime and cloud-provider transcription without taking on server lifecycle responsibilities.
status: in_progress
type: feature
scope: stt-sdk repository
attempt: 1
max_attempts: 5
last_result: partial
next_action: Fix the stale @voice-typer install path in scripts/verify-consumer.mjs, run typecheck/test/build/consumer verification, validate and publish the current breaking 0.3 release, update consumer pins, then add immutable consumer verification and cross-repository CI.
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

## Remaining Work

1. Fix the stale installed-package assertion in `scripts/verify-consumer.mjs:191`, which checks `node_modules/@voice-typer/stt-sdk` instead of `node_modules/@open-vibe-ai/stt-sdk`.
2. Run SDK typecheck, tests, build, and blank tarball consumer verification against the current 0.3 work; record results here.
3. Validate the breaking release contents/version, publish the current 0.3 release, and update whisper-vibes and any other consumer pins to the validated immutable version.
4. Add immutable released-package consumer verification and cross-repository App/Server CI so clean consumers compile/typecheck without sibling repositories or path/workspace links.

## Do Not Repeat

- Do not restore local faster-whisper WebSocket streaming; the 2026-09-05 decision makes this adapter batch-only while generic/cloud streaming remains in the SDK.
- Do not treat package scaffolding, the Deepgram proof, release history, or initial whisper-vibes adoption as unimplemented; audit existing evidence before adding work.

## Verification Log

### 2026-09-05 — Attempt 1 audit

- Static audit confirmed standalone package metadata and normalized public provider/types exports.
- Static audit confirmed FasterWhisper batch coverage and explicit unsupported streaming behavior.
- Static audit confirmed Deepgram batch/streaming cloud fixtures with no Server dependency.
- Static cross-repository audit confirmed published 0.1.0/0.2.0 lockfile history and whisper-vibes consumption.
- No typecheck, test, build, pack, consumer verification, publish, or cross-repository CI run was performed during this goal-tracking-only update.
- Blocking defect identified: stale `@voice-typer/stt-sdk` filesystem assertion in `scripts/verify-consumer.mjs:191`.

## Final Outcome

Partial; implementation and adoption evidence exists, but verification, breaking-release publication/pin updates, and immutable cross-repository CI remain.

## In Progress

- Status: yes
- Reason: Attempt 1 reconciled the goal with existing implementation and the 2026-09-05 batch-only faster-whisper decision. The concrete verification, release, consumer pinning, and CI work above remains active.
