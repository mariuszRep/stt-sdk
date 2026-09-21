# AGENTS.md — STT SDK

Repository instructions for agents working in this checkout of `stt-sdk`. This repo exists
on disk both as a standalone clone and as a git worktree nested under `voice-typer/` — if you
arrived here via `voice-typer/stt-sdk`, read the workspace root's `AGENTS.md` first (its
"Which checkout to use" and "Development workflow" sections) before doing anything cross-repo;
it governs whether you should be touching this checkout at all versus the sibling one.

## Read Order

Before planning or changing files, read:

1. Workspace `../AGENTS.md` (only if this checkout is nested under `voice-typer/` — see note above), then `../VISION.md` and `../CONVENTIONS.md`
2. This repository's `VISION.md` and `CONVENTIONS.md`
3. `AGENTS.md` (this file)
4. Relevant `.projectflows/goals/<status>/<goal-slug>/GOAL.md`
5. Relevant source files

## Architecture Boundary

- This repository owns the normalized provider-communication client contract: provider
  discovery, capabilities, models, batch/streaming transcription, transcript events,
  timestamps, and structured errors.
- It connects to endpoints only. It does not detect hardware, install providers/models,
  start/stop processes, or supervise local runtimes — those are `stt-server`
  responsibilities.
- `stt-sdk` must not depend on `stt-server`. `stt-server` may consume this package as a
  published, versioned npm library — never SDK source by repository-relative path.

## Project Rules

- Keep local-runtime providers and cloud providers behind the same normalized
  `SttProvider` contract.
- Additive changes to the provider contract are backward compatible within a major
  version; breaking changes need a new major version and an explicit migration path.
- The published tarball must contain `dist/`, `README.md`, and `LICENSE` only —
  `npm run verify:consumer` audits for `src/`, `test/`, `scripts/`, `.projectflows`,
  env, and credential files and fails if any leak in.

## Verify Commands

Run from the repo root:

```bash
npm run typecheck        # tsc --noEmit
npm run build            # tsup -> dist/ (esm + cjs + dts)
npm run test             # vitest run
npm run verify:consumer  # packs tarball, installs into a blank consumer fixture,
                         # typechecks ESM + CJS entry points, audits tarball contents
```

`verify:consumer` is the real release gate — run it before any version bump.

## Releasing

- Releases are tag-push only: `git tag vX.Y.Z <tested-sha>` → `git push origin vX.Y.Z`
  on an explicit release instruction only.
- `release.yml` builds, tests, and `npm publish`es via OIDC trusted publishing (no
  npm token), then creates the GitHub release.
- Version bumps are ordinary commits on the integration branch before the final
  candidate/validation run — see the workspace `RELEASE_PROCESS.md` for the full
  PR + candidate → tag-tested-SHA → promote flow.

## Documentation Rule

Durable product or technical direction belongs in `VISION.md` / `CONVENTIONS.md`.
Executable work belongs in `.projectflows/goals/<status>/<goal-slug>/GOAL.md`.
Do not maintain separate roadmap/status documents unless explicitly requested.
