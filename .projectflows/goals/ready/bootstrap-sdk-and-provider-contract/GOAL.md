---
name: bootstrap-sdk-and-provider-contract
title: Bootstrap and Publish the STT SDK Provider Contract
description: Build and publish the independent STT SDK that normalizes local-runtime and cloud-provider transcription without taking on server lifecycle responsibilities.
status: ready
type: feature
scope: stt-sdk repository
attempt: 0
max_attempts: 5
last_result: none
next_action: Scaffold the publishable TypeScript package, formalize the versioned provider contract from current App protocol behavior, and implement contract tests before consumer integration.
success_criteria:
  - SDK publishes a versioned public package with normalized batch and streaming provider interfaces.
  - SDK implements FasterWhisperProvider against the preserved local runtime protocol.
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
- The initial migration preserves current faster-whisper batch and streaming wire behavior. New provider functionality is excluded.
- Cloud use must function with no Server installed or running. The SDK must never depend on `stt-server`.

## Problem / Motivation

The current App embeds reusable contracts in `packages/shared`, implements direct batch HTTP in `apps/web/src/lib/api.ts`, and implements the local WebSocket protocol in `apps/web/src/providers/voice-typer-ws-provider.ts`. `stt-server` also contains a separate embedded TypeScript SDK. These duplicate and entangle the client boundary needed by independent App and Server releases.

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
3. Implement `FasterWhisperProvider` from the current App protocol:
   - batch multipart `POST /v1/audio/transcriptions` returning `{text}`;
   - runtime info/config discovery;
   - `WS /v1/audio/stream` start/binary-audio/stop/abort lifecycle and protocol-v1 events.
4. Establish adapter seams for `WhisperCppProvider` and named cloud providers without adding a first-time implementation of a provider beyond the selected initial contract proof.
5. Migrate/reconcile reusable content from `whisper-vibes/packages/shared` and `stt-server/sdk` into this package as the sole public provider contract.
6. Add unit, protocol-fixture, and package-consumer tests; publish artifacts consumable by clean App and Server CI jobs.

## Out of Scope

- Hardware detection, provider installation/update/removal, model catalog download/removal, runtime start/stop/health supervision, or recommendations.
- Implementing new provider services or changing current runtime endpoints/events.
- App UX integration and Server control-plane implementation.
- Any source-path coupling between repositories.

## Acceptance Criteria

1. `stt-sdk` builds, tests, packs, and installs successfully in a clean consumer project with no sibling repositories present.
2. The published public API exposes normalized provider capabilities, model data, batch transcription, streaming state/events, timestamps, errors, and versioned runtime descriptor types.
3. `FasterWhisperProvider` preserves the App's current multipart batch request/`{text}` response behavior and streaming protocol-v1 lifecycle/event behavior against fixtures.
4. The SDK has named adapter entry points for `FasterWhisperProvider` and `WhisperCppProvider`; unsupported/unimplemented capability behavior is explicit and typed rather than represented by App-specific branches.
5. At least one cloud adapter contract is verified without `stt-server` installed or running.
6. A code and dependency review confirms no SDK API or implementation performs lifecycle, hardware, model-management, inference, or Server-specific functions.
7. App and Server clean CI consumer jobs can install an immutable released SDK version and compile/typecheck against it.

## Judgment Rubric

- Not done if local and cloud adapters expose unrelated client contracts.
- Not done if preserved protocol fixtures change request shape, endpoint, event schema, session behavior, or unknown-field tolerance.
- Not done if the SDK requires `stt-server` for cloud usage or imports Server source.
- Not done if `packages/shared` or `stt-server/sdk` remains a competing source of public provider contract definitions after migration.
- Not done if consumers rely on a workspace/link/path version rather than a package artifact.

## Architecture Notes

- Current local batch client and response/config types: `whisper-vibes/apps/web/src/lib/api.ts:79-223`.
- Current local streaming adapter and protocol lifecycle: `whisper-vibes/apps/web/src/providers/voice-typer-ws-provider.ts:1-164`.
- Current shared live-transcription types import: `whisper-vibes/apps/web/src/providers/voice-typer-ws-provider.ts:1-7`; source package: `whisper-vibes/packages/shared`.
- Current runtime protocol implementation/baseline: `whisper-vibes/backend/app/main.py:141-207,280-464` and `whisper-vibes/backend/app/streaming.py:35-227`.
- Existing embedded SDK to reconcile/remove as a duplicate: `stt-server/sdk/package.json:1-22`.

## Risks / Unknowns

- Npm organization/package name, provenance configuration, and publishing credentials are not configured in the repository yet.
- The initial cloud-provider proof must be chosen from the named direction before implementation; do not silently expand provider scope.
- Browser, Node, and React-Native compatibility expectations need to be explicitly documented in package entry points; the current known consumer is browser/Electron App code.
- Server and App integration must be sequenced after a published SDK version exists; no temporary source linking is allowed.

## Verification Expectations

- Run clean dependency installation, typecheck, unit tests, protocol contract tests, build, `npm pack`, and installation of the tarball into a blank consumer fixture.
- Test `FasterWhisperProvider` batch and streaming behavior against fixtures that encode the current App/runtime contract, including ready/partial/final/lagging/error/closed events and binary PCM transport.
- Test the chosen cloud adapter through the same public provider interface without a Server process.
- In CI, publish a prerelease or release artifact and run separate App and Server consumer jobs against its exact version.
- Verify package exports and tarball contents contain no private app code, credentials, or Server source.

## Attempts

No attempts yet.

## Do Not Repeat

None yet.

## Verification Log

No verification yet.

## Final Outcome

Pending.

## Ready For Execution

- Status: yes
- Reason: The SDK boundary, current contract sources, migration target, prohibited responsibilities, consumer model, and verification evidence are defined. The package registry name and first cloud proof are delivery configuration decisions that can be selected without changing the product boundary.
