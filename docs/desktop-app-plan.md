# Desktop app plan (macOS and Windows)

Status: planned, nothing built. Written 2026-10-27. Builds on step 6 of [local-mode-plan.md](local-mode-plan.md).

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Licensing | Free, Apache 2.0, same as the repo |
| 2 | Work on a user-chosen folder | Yes, opt-in per workflow, shown in the run plan (Phase 3) |
| 3 | Code signing | None for now: unsigned builds (consequences below) |
| 4 | `git`, `uv`, `bun` | Detect and guide; do not bundle |

## Approach: wrap, do not convert

An Electron shell runs the existing `startLocal()` (`src/local/up.ts`) in its main process and opens
the web UI at the loopback URL. `src/` is unchanged apart from the build changes below. Electron over
Tauri because the server, worker, Temporal client and PGlite all need Node; Tauri would still ship and
supervise a Node sidecar.

## Critical path: there is no build step

The CLI runs TypeScript through `tsx` (`bin/azhi.js`), and Temporal bundles the workflow with webpack
and SWC when the worker starts. A packaged app cannot depend on either. Phase 0 exists to prove this.

## Phase 0: spike (about 3 days)

1. Compile `src/` to `dist/` (esbuild or `tsc`); keep the `tsx` path for development.
2. Pre-bundle the interpreter workflow with `bundleWorkflowCode()` at build time and pass
   `workflowBundle` to `Worker.create` in `src/runtime/interpreter.ts`. No webpack or SWC at runtime,
   which also retires the `SWC_NATIVE_BINDING_CACHE` Windows workaround.
3. Run `startLocal()` from `dist/` under plain Node on Windows and macOS.
4. Kill criterion: if the pre-bundled workflow cannot run the existing e2e tests, stop and revisit.

## Phase 1: the shell (about 1 week)

- `desktop/` package: Electron main process, single-instance lock, splash with progress.
- Startup: `startLocal({ port: 0 })`, read `server.localTokenFile`, open
  `http://127.0.0.1:<port>/ui#<token>` (the same handoff as `azhi open`). Quit calls `handle.stop()`.
- Renderer: `nodeIntegration` off, `contextIsolation` on, sandboxed, navigation limited to the loopback
  origin, existing CSP kept (`src/web/routes.ts`). The token appears only in the window URL.
- Bundle the Temporal CLI in the installer (look in `resources/` before downloading in
  `ensureTemporalCli`); the pinned SHA-256 check stays.
- Data stays in `~/.azhi`.

## Phase 2: native behavior (3 to 4 days)

- Tray icon and background mode, so schedules and approvals still fire with the window closed.
- Notifications for pending approvals.
- Update check that notifies and links to the release page (see Unsigned builds for why not silent update on macOS).

## Phase 3: worker prerequisites and local folders (about 1.5 weeks)

- First-run "what is missing" screen from the `capabilities.ts` detection (`azhi doctor` output) for
  `git`, `uv` or Python, `bun`, OpenCode. Detect and link to installers; bundle nothing.
- `limits.memory_mb` is enforced only on Linux (`prlimit`). Elsewhere the run plan warns that it is not enforced
  and the step runs with its time limit; the UI shows the reason. `AZHI_REQUIRE_MEMORY_LIMITS=1` makes it a blocker.
- `workspace: local`: a workflow may point its workspace at a folder the user picks (native folder
  dialog). Requirements, because this weakens isolation:
  - off by default, opt-in per workflow, and recorded in the run plan as a capability with its own
    policy coverage mark (not "enforced" for filesystem isolation);
  - the folder is chosen in the UI by the user, never taken from workflow, ticket, issue or PR text;
  - writes still go through the gateway and ledger; the approval gate and taint rule apply unchanged;
  - nothing merges, closes or force-pushes (project rule), so a git folder gets a branch, not a push to the default branch.
  Open design question to settle in its own ticket: whether harness steps work in the folder directly or
  in a git worktree of it. A worktree is the safer default.
- Close the open items from the local-mode plan: single-process PGlite crash-durability test, macOS runs.

## Phase 4: packaging and CI (about 1 week)

- `electron-builder`: macOS `dmg` and `zip` (x64 and arm64), Windows NSIS installer (x64; arm64 only if
  Temporal, PGlite and the native addon pass).
- Native addon: `@temporalio/core-bridge` must be listed in `asarUnpack` with the right per-arch binaries.
- CI matrix `ubuntu`, `macos`, `windows` running `npm run test:local`; installers built on tags and
  attached to a GitHub release.

## Unsigned builds: what users will hit

- **macOS:** Gatekeeper blocks the first launch. On macOS 15 and later the right-click Open shortcut is
  gone; users go to System Settings, Privacy & Security, Open Anyway (or run `xattr -dr
  com.apple.quarantine`). Apple Silicon requires at least an ad-hoc signature, which electron-builder
  applies by default; keep it, and ad-hoc sign the bundled Temporal binary too. Silent auto-update on
  macOS needs a signed app, so updates there are a manual download.
- **Windows:** SmartScreen shows "Windows protected your PC"; users click More info, then Run anyway.
  Expect more antivirus false positives than for a signed app. Auto-update through `electron-updater`
  works unsigned as long as no publisher name is pinned.
- Publish SHA-256 checksums with each release and put the steps above in the install docs.
- Revisit signing before wider distribution. Apple's developer program is a yearly fee; Windows has
  cloud-signing options. Neither changes the code, only the build pipeline.

## Sizing

About 4 to 5 weeks for one developer to an unsigned beta. Inferred from reading the code, not
measured; Phases 0 and 3 are the uncertain ones.

## Risks

- Workflow pre-bundling does not work with the interpreter's imports (Phase 0 decides).
- PGlite or Temporal dev server misbehave under macOS file locking or Windows antivirus scanning.
- Electron size (about 150 to 250 MB installer) plus the Temporal CLI.
- `workspace: local` is a real weakening of the product's isolation claim; it must stay visibly opt-in.
