---
name: protocol-driven-local-provider
title: Select Local Providers by Protocol, Not by Engine Name
description: Replace createProvider's hardcoded per-engine switch with one local adapter selected on descriptor.protocol, and wire the descriptor's auth field, so any conformant runtime works without an SDK release.
status: in_progress
type: refactor
scope: stt-sdk/src/factory.ts, src/providers/, src/index.ts, test/seams.test.ts, test/faster-whisper.e2e.test.ts
attempt: 1
max_attempts: 5
last_result: partial
next_action: |
  All code, tests, and manual verification complete. One acceptance check (npm run verify:consumer)
  could not run due to a pre-existing, unrelated environment issue: npm pack --json's prepack hook
  (which runs the build) writes tsup's build log to stdout ahead of the JSON output, breaking
  verify-consumer.mjs's JSON.parse regardless of any SDK code change -- reproduced with a bare
  `npm pack --json --dry-run` on this checkout, nothing to do with this goal's changes. Re-run
  verify:consumer once that tooling issue is fixed (likely as part of bootstrap-sdk-and-provider-contract,
  which already owns release/consumer-verification mechanics and already has one other known bug
  logged against the same script).
success_criteria:
  - createProvider selects the local adapter on descriptor.protocol rather than descriptor.provider, so a conformant runtime with an unknown provider id works.
  - FasterWhisperProvider and WhisperCppProvider remain exported and behaviourally unchanged for existing consumers.
  - descriptor.auth is honoured — a token descriptor produces Authorization-bearing requests to the runtime.
  - The same SDK code path transcribes successfully against both faster-whisper and sherpad with no engine-specific branching.
source: user
---

# Select Local Providers by Protocol, Not by Engine Name

## Goal

Make the SDK engine-agnostic for local runtimes: a conformant runtime should work because it
implements the protocol, not because the SDK was recompiled to know its name.

## Source Requirements

User, this session: *"how we keep it perfect, so if anyone wants to use STT SDK without STT server,
to manage the faster whisper, whisper CPP or sherpa, then they should be able to"* — the SDK must be
useful standalone, against a runtime the caller started themselves.

## Problem / Motivation

`src/factory.ts`'s `createProvider` validates `schemaVersion === 1`, then switches on
`descriptor.protocol` (`"voice-typer-v1"` only), then switches on **`descriptor.provider`**, accepting
exactly `"faster-whisper"` and `"whisper-cpp"` and throwing `UnsupportedCapabilityError` for anything
else.

Three consequences, all bad for a contract library:

1. **A conformant runtime is rejected for having the wrong name.** `sherpad` will implement the
   protocol exactly and still throw, until an SDK release adds a string.
2. **Every future engine costs an SDK release** plus a version-pin bump across `stt-server` and
   `whisper-vibes` — the opposite of the "adding an engine is a catalog entry plus one adapter
   module" property `stt-server` works hard to preserve.
3. **Standalone use is effectively blocked.** Someone pointing the SDK at their own conformant
   runtime cannot, which contradicts `VISION.md`'s framing of the SDK as the normalized client
   contract rather than a companion to one server.

Separately and independently: **`descriptor.auth` is dead code.** It is defined in `types.ts`,
populated by `stt-server` on every start, and read by nothing — no local adapter sends an
`Authorization` header. `sherpad` will enforce bearer auth, so this must be wired or the two cannot
talk at all once a token is configured.

Worth noting what is *not* the problem: the adapters themselves are already generic. Engine coupling
is concentrated entirely in the factory's second switch, and everything downstream is generic over
`SttProvider`. This is a small change to a well-placed seam.

## Vision Alignment

- `VISION.md`: the SDK owns the normalized client contract and never depends on `stt-server`.
  Selecting on protocol rather than on a server-assigned engine id strengthens that independence.
- `CONVENTIONS.md`: the local protocol declares a version, and additive changes stay compatible
  within a major. Keying on the declared protocol version is literally what that sentence implies.
- Cloud providers (Deepgram, OpenAI, Groq) genuinely differ and keep their own classes — this goal
  changes only how *local runtime* providers are selected.

## Scope

1. **One local adapter.** Implement `LocalRuntimeProvider` against the protocol, selected when
   `descriptor.protocol === "voice-typer-v1"`, regardless of `descriptor.provider`. Its behaviour is
   today's `FasterWhisperProvider` — that adapter is already written against the protocol, not
   against faster-whisper specifically.
2. **Keep the named exports.** `FasterWhisperProvider` and `WhisperCppProvider` remain exported and
   constructible, delegating to the shared implementation, so no 0.3.x consumer breaks. `whisper-vibes`
   imports `createProvider` rather than the classes, but the classes are public API and removing them
   would be a breaking change for no gain.
3. **Wire `descriptor.auth`.** When `auth.type === "token"`, send `Authorization: Bearer <value>` on
   every runtime request. Keep it strictly descriptor-driven — the SDK should not invent, store, or
   negotiate credentials.
4. **`descriptor.provider` becomes informational**, surfaced on the provider's `id`/`capability` for
   diagnostics rather than used for dispatch.
5. **Preserve the existing rejections**: unknown `protocol` and `schemaVersion !== 1` must still
   throw `UnsupportedCapabilityError`. Those are real contract violations; an unrecognised engine
   name is not.
6. Update `test/seams.test.ts`, which currently pins the old behaviour, including its case asserting
   that a descriptor advertising `streaming.enabled: true` still yields a batch-only provider — that
   assertion should survive, since local streaming remains unimplemented.

## Out of Scope

- Implementing local streaming. `createStream()` continues to throw `UnsupportedCapabilityError` for
  local runtimes; the 2026-09-05 removal decision stands and its "Do Not Repeat" is respected.
- Cloud adapter changes.
- Sending `model` or `language` in the batch request. A managed runtime serves one model, chosen by
  the control plane; language selection is tracked separately by `whisper-vibes`'
  `transcription-language-selection`.
- Publishing. The `bootstrap-sdk-and-provider-contract` goal owns release mechanics; this goal should
  land inside whatever version that publishes.

## Acceptance Criteria

1. A descriptor with `provider: "sherpa-onnx"`, `protocol: "voice-typer-v1"` produces a working
   provider.
2. A descriptor with an unrecognised `protocol`, or `schemaVersion: 99`, still throws.
3. `FasterWhisperProvider` and `WhisperCppProvider` remain exported with unchanged behaviour.
4. A token-bearing descriptor produces `Authorization: Bearer <value>` on runtime requests; a
   descriptor without `auth` sends no such header.
5. The same code path transcribes against both faster-whisper and `sherpad`.
6. `npm test`, `npm run typecheck`, and `verify:consumer` pass.

## Judgment Rubric

- Not done if any dispatch still reads `descriptor.provider`.
- Not done if a previously working consumer of the named classes breaks.
- Not done if `descriptor.auth` remains unread.
- Not done if it silently accepts an unknown protocol version — that is a real incompatibility and
  must still fail loudly.

## Risks / Unknowns

1. **`test/seams.test.ts` encodes the current behaviour as intended**, including rejection of unknown
   providers. Those assertions are being deliberately inverted; update them with a comment saying why,
   so a future reader does not "fix" the test back.
2. **`bootstrap-sdk-and-provider-contract` is `in_progress`** and names `FasterWhisperProvider` /
   `WhisperCppProvider` as its adapter seams. Coordinate rather than collide; this goal narrows those
   seams to aliases and should be reflected there.
3. **Auth is untested end to end anywhere today.** `sherpad`'s enforcement and this client-side
   implementation land at roughly the same time — make sure at least one test drives a real
   token-protected request rather than asserting only header construction.

## Verification Expectations

### Automated Verification
- `npm test` (vitest), `npm run typecheck`, `npm run verify:consumer`.
- Extend `test/faster-whisper.e2e.test.ts`'s real in-process server pattern to cover a
  token-protected runtime.

### Manual Verification
- Against a running `sherpad`, construct a descriptor by hand (no `stt-server` involved) and
  transcribe — this is the standalone-use case that motivates the goal, so prove it directly.

## Attempts

### Attempt 1 (2026-09-09)

1. **`src/providers/local-runtime.ts`** (new): `LocalRuntimeProvider`, the real, protocol-driven
   implementation -- `id`/`capability` configurable via constructor rather than hardcoded, wires
   `descriptor.auth` (`Authorization: Bearer <value>` on every request when `auth.type === "token"`,
   no header at all otherwise), everything else is `FasterWhisperProvider`'s exact prior logic
   (multipart batch request, `/v1/config` for `listModels`, batch-only `createStream` rejection).
2. **`src/providers/faster-whisper.ts`**: rewritten to a thin `FasterWhisperProvider extends
   LocalRuntimeProvider`, fixing `id: "faster-whisper"` and the exact historical capability object
   literal via `super()` -- source-compatible, zero behavior change for direct construction.
3. **`src/providers/whisper-cpp.ts`**: left untouched, deliberately. It's still the stubbed,
   always-throws seam it always was -- `createProvider` just no longer routes to it.
4. **`src/factory.ts`**: `createProvider` now switches on `descriptor.protocol` only. Any
   `"voice-typer-v1"` descriptor gets a `LocalRuntimeProvider` with `id`/`capability.id` set from
   `descriptor.provider` (informational only, never used for dispatch). Unknown `protocol` and
   `schemaVersion !== 1` still throw `UnsupportedCapabilityError` -- real incompatibilities, not
   naming gaps.
5. **`src/{index.ts,providers/index.ts}`**: export the new `LocalRuntimeProvider`/`LocalRuntimeOptions`.
6. **`test/seams.test.ts`**: rewrote the four assertions that pinned the old dispatch-by-name
   behavior, with an explicit "do not fix these back" comment explaining why, plus three new tests:
   an unrecognized provider name (`sherpa-onnx`) working, `whisper-cpp` now getting a real provider
   rather than the stub, and end-to-end `Authorization` header wiring (present with a token, absent
   without).
7. **`test/faster-whisper.e2e.test.ts`**: added a second describe block with a real in-process HTTP
   server that *actually enforces* a bearer token (unlike faster-whisper's own Python sidecar --
   Risk #3's "auth is untested end to end anywhere" is now closed with a server that genuinely
   checks, not just header-construction assertions).
8. One real TypeScript fix needed: `HeadersInit` isn't available under this package's `lib: ["ES2022"]`
   tsconfig (no `"DOM"` lib) -- used `Record<string, string> | undefined` instead, portable and
   sufficient.

## Do Not Repeat

- Do not assume `npm pack --json` produces clean JSON when the package has a `prepack` script that
  writes to stdout (here, `npm run build` → tsup's own colored CLI log). Verified this breaks with a
  bare `npm pack --json --dry-run`, unrelated to any SDK source change -- don't spend time debugging
  SDK logic when `verify:consumer` fails this way.

## Verification Log

- 2026-09-09 — `npm run typecheck`: clean.
- 2026-09-09 — `npm test`: 30/30 passing (up from 25; 4 seams.test.ts failures from the deliberately
  inverted assertions, expected and then fixed; net +5 tests: unrecognized-provider-works,
  whisper-cpp-gets-real-provider, auth-header-wiring in seams.test.ts, plus 2 real-server auth tests
  in faster-whisper.e2e.test.ts).
- 2026-09-09 — Manual verification (the goal's own explicit requirement): built the package
  (`npm run build`), started a real `sherpad` instance standalone (`VOICE_TYPER_AUTH_TOKEN` set, no
  `stt-server` running or involved anywhere), and from a plain Node script importing only the built
  `dist/index.js`, hand-constructed a descriptor naming provider `"sherpa-onnx"` (a string that
  appears nowhere in the SDK's source) with a real `auth` token, called `createProvider()`, and ran a
  real `transcribe()` — succeeded, correct text, correct full response shape (`durationMs`,
  `segments[].avgLogprob`/etc. correctly `null` not fabricated, matching what sherpad actually sends).
  This is the concrete proof of the goal's entire premise: standalone SDK use against an engine it
  was never told about.
- 2026-09-09 — `npm run verify:consumer`: did not complete — pre-existing, SDK-code-independent
  tooling issue (see Do Not Repeat). `npm test`/`typecheck` plus the manual proof above stand in for
  it for this attempt.

## Final Outcome

**Complete except one unrunnable, pre-existing-and-unrelated acceptance check.** Every code change,
every test (including three new ones specifically proving the goal's premise), and the required
manual standalone-usage verification are done and passing. `descriptor.auth` is no longer dead code —
proven against a real server that actually enforces it, both in an automated e2e test and manually
against real `sherpad`. `FasterWhisperProvider`/`WhisperCppProvider` remain exported with unchanged
behavior. The only gap is `verify:consumer`, blocked by tooling unrelated to this goal's scope.

## Ready For Execution

- Status: in_progress
- Reason: Functionally complete; `verify:consumer` re-run is the only remaining item, gated on a
  separate tooling fix outside this goal's scope.
