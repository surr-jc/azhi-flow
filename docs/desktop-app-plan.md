# Desktop app (macOS and Windows)

Status: built on Windows (verified, see below); macOS written but not yet run. Updated 2026-11-16. Builds on step 6
of [local-mode-plan.md](local-mode-plan.md).

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Licensing | Free, Apache 2.0, same as the repo |
| 2 | Work on a user-chosen folder | Yes, opt-in per workflow, shown in the run plan ([local-workspaces.md](local-workspaces.md)) |
| 3 | Code signing | None for now: unsigned builds (consequences below) |
| 4 | `git`, `uv`, `bun` | Detect and guide; do not bundle |
| 5 | Shell | Electron, as a thin shell around a Node sidecar (not the server inside Electron) |
| 6 | Distribution | GitHub Releases only: a pushed `v*.*.*` tag builds the installers and attaches them, with SHA-256 checksums, to a **draft** release. No npm, stores, winget or Homebrew |

## Design: an Electron shell around the `azhi up` code

```
Azhi Flow.exe / .app  (Electron: window, tray, notifications)
  └─ resources/node/node        bundled Node 22, pinned and checksum-verified
       └─ resources/app/src/local/sidecar.js   compiled backend = the `azhi up` code
            ├─ Temporal dev server   resources/temporal/temporal  (AZHI_TEMPORAL_BIN)
            ├─ PGlite database       ~/.azhi/local/db
            └─ server + worker       http://127.0.0.1:7400
```

Why a sidecar and not `startLocal()` inside Electron's main process (the earlier plan):

- Six places start `process.execPath` to run `bin/azhi.js` or the MCP bridge (the Claude, Codex and OpenCode
  harnesses). Inside Electron that is the Electron binary, so each would launch another copy of the app.
- A busy worker would share a process with the window.
- The Temporal native addon runs under the Node it is tested on.

The shell keeps `nodeIntegration` off, `contextIsolation` and `sandbox` on, no preload, and only lets the window
show the local server; other links open in the default browser. The owner token reaches the page only in the URL
fragment (the same handoff as `azhi open`). Quitting asks the sidecar to stop over IPC (Windows has no SIGTERM), so
PGlite and Temporal close cleanly.

## What was built

| Piece | Where |
|---|---|
| Compiled backend with no `tsx` and no bundling at start-up | `npm run build:app` (`scripts/build-app.mjs`, `tsconfig.build.json`) writes `build/app` |
| Pre-bundled interpreter workflow | `workflow-bundle.js` and `interpreter-build.json` next to `src/runtime/interpreter.ts`; the source path is used when they are absent |
| Compiled-or-source launchers | `bin/azhi.js`, `bin/azhi-gateway-mcp.js` |
| Sidecar entry | `src/local/sidecar.ts` |
| Pinned Node and Temporal CLI | `scripts/fetch-runtime.mjs` |
| Shell, tray, notifications, update check, missing-tools prompt | `desktop/src/main.ts`, `desktop/src/background.ts` |
| Packaging | `desktop/electron-builder.yml`, `desktop/scripts/after-pack.cjs`, `desktop/scripts/mac-adhoc-sign.cjs` |
| CI | `.github/workflows/desktop.yml` (Windows x64, macOS arm64, macOS x64) |

Behaviour: closing the window hides it to the tray so schedules and approvals keep running; Quit stops everything.
A notification appears for each new approval the signed-in user can decide (one summary if several arrive at once).
Once a day the app asks GitHub for the latest release of this repository (no user data sent; set
`AZHI_DESKTOP_NO_UPDATE_CHECK=1` to turn it off) and notifies with a link, never an in-place update. Once per set of
missing tools it lists what the worker did not find (Git, Python or uv, Bun) with links to the installers.

## What was learned building it

- **electron-builder never copies a folder called `node_modules`** from `extraResources`, whatever the filter says.
  `desktop/scripts/after-pack.cjs` copies the backend's modules in. This is easy to miss: if the package sits inside a
  source checkout, Node finds the checkout's `node_modules` and the app appears to work. Test a package from outside the
  repository.
- **Size.** The staged backend is about 1.2 GB before pruning, 825 MB after: `opencode-ai` leaves a copy of its binary at
  `opencode-ai/bin/opencode.exe` (the only path Azhi runs), so the build removes the two platform packages it came from
  (about 200 MB each). The rest is the Claude Agent SDK's native runtime (238 MB), Temporal's native bridge (145 MB),
  OpenCode (202 MB) and the Temporal CLI (160 MB, outside `node_modules`). Installer sizes are in the release notes.
- **Start-up** takes 40 to 60 seconds on a cold first launch on the development machine (Temporal dev server, database
  migrations, worker registration); the window shows a "starting" page meanwhile.
- A hook-free `tar` is not guaranteed on Windows (Git's GNU tar cannot read `.zip`), so `fetch-runtime.mjs` extracts
  with PowerShell there.

## Verified, and not

Verified on Windows 11 with Node 24 on the host: the compiled backend under plain Node (`doctor` all ok, a Python
script workflow, stop and restart with run history kept); the Electron window (signed in, renderer has no Node, second
launch focuses the first, close-to-tray with the backend still healthy, Quit leaves no `node` or `temporal` process and
removes the pid file); the packaged `win-unpacked` app run from outside the repository (bundled Node and Temporal,
`claude-agent-sdk` and OpenCode found, a workflow succeeds).

Not verified: running the NSIS installer itself; any macOS build (the workflow and the ad-hoc signing hook are written
but have never run); a live OpenCode, Claude or Codex harness step from the packaged app (they need model access);
notification delivery on screen; the update check against a real release.

## Unsigned builds: what users will hit

- **macOS:** Gatekeeper blocks the first launch. On macOS 15 and later the right-click Open shortcut is gone; users go
  to System Settings, Privacy & Security, Open Anyway (or run `xattr -dr com.apple.quarantine "/Applications/Azhi
  Flow.app"`). Apple Silicon requires at least an ad-hoc signature: `mac-adhoc-sign.cjs` signs every bundled Mach-O
  file and the app. Silent auto-update on macOS needs a signed app, so updates there are a manual download.
- **Windows:** SmartScreen shows "Windows protected your PC"; users click More info, then Run anyway. Expect more
  antivirus false positives than for a signed app.
- Each release publishes SHA-256 checksums (`SHA256SUMS.txt`); the steps above are in [install.md](install.md).
- Revisit signing before wider distribution. Apple's developer program is a yearly fee; Windows has cloud-signing
  options. Neither changes the code, only the build pipeline.

## Open items

- Run the macOS builds on real Macs (arm64 and x64); `macos-15-intel` is the assumed runner label for x64.
- Single-process PGlite crash-durability test (from the local-mode plan).
- A native folder picker for `workspace.local` (the path is typed on the Workers page today).
- Windows arm64 only if Temporal, PGlite and the native addon pass.
- Decide whether to ship the Claude Agent SDK runtime in the installer or fetch it on first use (238 MB).
