---
name: validate
model: haiku
description: Runs the project's own quality gate (tests, type-check, lint, build) and reports PASS or FAIL with only the failing lines. Use before opening a PR.
---

# Validate

Run this project's real gate, mirroring CI, and stop at the first failure.

## Find the commands (once, in this order)

1. A `## Commands` section in `CLAUDE.md` (authoritative; use it as written).
2. CI config (`.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`).
3. Manifests: `package.json` scripts, `Makefile`/`justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
   `pom.xml`/`build.gradle`, `*.csproj`.

If none give a command, ask the user once and offer to record the answer in `CLAUDE.md`.

Typical order: type-check, lint, tests, then build only if build-affecting files changed.
While iterating, run the narrowest test target first, then the full gate once.

## Token discipline

- Never paste full logs. Report the command, pass/fail, and the failing test names with the first
  error line each (max 20 lines total).
- Do not re-run a green step.
- Do not fix anything here; hand failures back to the caller.

## Report

- Type-check / Lint / Tests (N passed, M failed, names) / Build: PASS, FAIL or skipped
- Overall: **PASS / FAIL**
