# AGENTS.md — STT SDK

This repo owns `@open-vibe-ai/stt-sdk`: the normalized provider-communication client
contract (TypeScript, published to npm).

## Which checkout am I in?

This repo exists TWICE on disk, as two git worktrees sharing one object database:

```
Projects/stt-sdk              standalone clone      branch: main
Projects/voice-typer/stt-sdk  linked worktree       branch: voice-typer-windows   ← dev happens here
```

`voice-typer-windows` is the integration branch in ALL THREE repos — same name in
stt-sdk, stt-server and whisper-vibes. There is no per-repo variant such as
"stt-sdk-windows"; if you are looking for one, it does not exist.

Decide from your working path, never from which branch looks newer or has more commits:
  path contains /voice-typer/  → use this worktree, on the branch already checked out
  path does NOT                → use this clone's own `main`

The two are normally on DIFFERENT commits. Committing to the wrong one makes the work
invisible to the other and is expensive to reconcile — see the 2026-08-30 incident in
this repo's history.

Ignore these stale local branches, they are not part of the flow:
`feat/bootstrap-sdk-and-provider-contract`
Confirm state before any cross-repo work: `../scripts/check-worktrees.sh`

## Read Order

1. This repository's `VISION.md` and `CONVENTIONS.md`
2. `AGENTS.md` (this file)
3. Relevant `.projectflows/goals/<status>/<goal-slug>/GOAL.md`
4. Relevant source files

The workspace root's `../AGENTS.md` matters only when a change spans repos (e.g. a gitlink
bump or the cross-repo train) — everything below is self-contained for this repo.

## Boundaries

| Owns | Must not own |
|---|---|
| Provider discovery, capabilities, models, batch/streaming transcription, transcript events, timestamps, structured errors — one `SttProvider` contract for local runtimes and cloud APIs | Hardware detection, provider/model install, process start/stop, runtime supervision (all `stt-server`); any dependency on `stt-server` |

`stt-server` may consume this package as a published, versioned npm library — never SDK
source by repository-relative path.

## Project Rules

- Keep local-runtime providers and cloud providers behind the same normalized
  `SttProvider` contract.
- Additive changes to the provider contract are backward compatible within a major
  version; breaking changes need a new major version and an explicit migration path.
- The published tarball must contain `dist/`, `README.md`, and `LICENSE` only —
  `npm run verify:consumer` audits for `src/`, `test/`, `scripts/`, `.projectflows`,
  env, and credential files and fails if any leak in.

## Verify Commands

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsup -> dist/ (esm + cjs + dts)
npm run test             # vitest run
npm run verify:consumer  # packs tarball, installs into a blank consumer fixture,
                         # typechecks ESM + CJS entry points, audits tarball contents
```

`verify:consumer` is the real release gate — run it before any version bump.

## Build, test, release

This repo ships a library, not binaries — there is deliberately **no** `candidate-*.yml`
and no artifact promote step; do not add one. `ci.yml` IS the validation pipeline, and it
carries `permissions: contents: read` only, so it is structurally incapable of npm's OIDC
trusted publishing.

```
push to voice-typer-windows ──▶ ci.yml runs on every push; a draft PR titled "vX.Y.Z"
                                stays open (ensure-pr.yml opens one if none exists)
merge PR ─────────────────────▶ main is now releasable; no candidate artifacts needed
tag the tested SHA ───────────▶ release.yml builds + tests + `npm publish` via OIDC,
                                then creates the GitHub release
```

1. Push to `voice-typer-windows` — `ci.yml` is the standing guard.
2. Bump `version` in `package.json` (ordinary commit on the branch) so it is greater than
   `npm view @open-vibe-ai/stt-sdk version`.
3. Merge the PR to `main`.
4. On an explicit release instruction only:
   `git tag vX.Y.Z <tested-sha>` → `git push origin vX.Y.Z`.
   `release.yml` repacks from the tagged commit by design (npm OIDC trusted publishing) —
   "promote not rebuild" here means the tag *is* the source.
5. Rollback: `npm deprecate` the bad version, or tag a new version on a known-good commit —
   publishing always repacks from whatever commit the tag names.

## Documentation Rule

Durable product or technical direction belongs in `VISION.md` / `CONVENTIONS.md`.
Executable work belongs in `.projectflows/goals/<status>/<goal-slug>/GOAL.md`.
Do not maintain separate roadmap/status documents unless explicitly requested.
