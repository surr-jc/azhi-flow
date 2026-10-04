# Local mode: Azhi Flow without Docker

Status: steps 0–3 built; step 4 done for Windows (macOS untested); steps 5–6 not started. Owner: Suresh.
Written 2026-10-04. See "Progress" at the end.

## Goal

Install and run Azhi Flow the way people install Claude Code or OpenCode: one package, one
command, data in the user's home folder, no Docker, on Linux, macOS and Windows (natively, not
WSL2).

```bash
npm install -g azhi-flow
azhi up            # server, durable engine and a worker in one process; prints the web link
```

The team install (`deploy/install.sh` with PostgreSQL and Temporal in Docker) stays as it is and
remains the supported production setup. Local mode is a second way to run the same code, aimed at
one developer on one machine. It is also the base for a later desktop app (a Tauri or Electron
window around `azhi up`).

## What ties Azhi to Docker today

Checked against the source on `main` (about 8,600 lines in `src/`):

| Dependency | Where | What it is used for |
|---|---|---|
| PostgreSQL 16 | `src/db/pool.ts`, `migrate.ts`, `server/outbox.ts`, `server/runs.ts`, `server/scheduler.ts`, `gateway/ledger.ts`, `knowledge/datasets.ts` (about 170 `query` calls) | All state. Uses `jsonb`, `ON CONFLICT`, `LISTEN/NOTIFY` (outbox wake-up), advisory locks (migrations), `FOR UPDATE SKIP LOCKED`, `tsvector` full text and `pgvector` (`<=>`) for dataset retrieval |
| Temporal | 10 files: `runtime/`, `worker/`, `server/server.ts`, `server/outbox.ts`, `api/app.ts` | Durable runs: the interpreter workflow, gateway and execution activities, crash recovery |
| Linux | `worker/capabilities.ts`, `worker/script-activity.ts`, `worker/harness-activity.ts` | `prlimit` for script memory limits; process-group kill (`detached` + `process.kill(-pid)`) for scripts and OpenCode |

Nothing else needs a container: the API, web UI, compiler, CEL, gateway and agents are plain Node.

## Approach: embed the two services, don't remove them

### 1. Database: PGlite behind the existing `pg` interface

[PGlite](https://pglite.dev) is PostgreSQL compiled to WebAssembly, running inside Node with its
data in a folder. It is real Postgres, so the migrations and SQL (jsonb, tsvector, advisory
locks, `LISTEN/NOTIFY`) keep working, and it ships `pgvector` as an extension. Drizzle, which
`pool.ts` already uses, has a PGlite driver.

Work:

- A small adapter in `src/db/` that gives PGlite the subset of `pg.Pool` / `PoolClient` the code
  uses: `query`, `connect`/`release`, and `on('notification')` for the outbox listener.
- `AZHI_DATABASE_URL=pglite://~/.azhi/db` selects it; `postgres://` keeps today's behaviour.
- PGlite has a single connection, so `tx()` must queue transactions instead of opening them in
  parallel. A mutex in the adapter covers this; it serialises writes, which is fine for one user.
- `CREATE EXTENSION vector` loads PGlite's vector extension instead.

### 2. Durable engine: Temporal's single-binary dev server

`temporal server start-dev --db-filename ~/.azhi/temporal.db` runs the whole Temporal service in
one process with SQLite storage. Builds exist for Linux, macOS and Windows (x64 and arm64), and the
TypeScript SDK's native worker already supports all three.

Work:

- `src/local/temporal.ts`: find or download the pinned `temporal` CLI into `~/.azhi/bin`
  (checksum-verified), start it on a free port, wait for health, stop it on exit.
- Keep runs durable across restarts by always using the same database file.

### 3. `azhi up`: one process

- Start PGlite, start the Temporal dev server, run migrations, then `startServer()` with all roles
  and an in-process `startWorker()` (both exist today and are already separable).
- Default everything to `~/.azhi` (`settings.ts` already defaults `dataDir` there), local auth,
  and print the `azhi open` link. `azhi down` stops it; `azhi up --background` for later.

### 4. Windows and macOS workers

- Process trees: replace `process.kill(-pid)` with a cross-platform tree kill (`taskkill /T /F`
  on Windows) in `script-activity.ts` and `harness-activity.ts`.
- Python: detect `uv`, then `python3`, then `py -3` / `python` on Windows.
- Memory limits: stay unsupported off Linux; the run plan already marks them, so workflows that
  set `limits.memory_mb` are refused with a clear reason. Later: Job Objects on Windows.
- Paths: audit `join`/`/`-joined paths and shell quoting; run the suite on Windows to find the rest.

### 5. Working on the user's own files

Claude Code and OpenCode act directly on the folder you open. Azhi currently runs scripts and the
OpenCode executor in a per-run workspace, with tool access going through the gateway. Local mode
can add a `workspace: local` option that points that workspace at a folder the user chooses, but
this weakens the isolation guarantees, so it should be opt-in per workflow and shown in the run
plan like any other capability. **Decision needed** before building this part.

### 6. Packaging

1. **npm package** (`npm install -g azhi-flow`): first, cheapest, works everywhere Node 22 does.
2. **Installers** (Windows `.msi`/winget, Homebrew): bundle Node and the Temporal binary.
3. **Desktop app**: Tauri or Electron shell that runs `azhi up` and shows the web UI. Needs code
   signing (Apple notarisation, Windows certificate) before selling.

## Tests

- Run the existing Vitest suite against both backends (`postgres://` and `pglite://`) in CI.
- The crash suite (`test/crash-suite.test.ts`) and the ledger tests must pass on PGlite: they are
  what proves "durable, exactly-once delivery" still holds.
- CI matrix: `ubuntu-latest`, `macos-latest`, `windows-latest` for local mode.

## Risks

- **PGlite durability under crashes.** It persists to the filesystem; the crash suite must show no
  lost ledger entries. If it fails, fall back to an embedded real Postgres (for example
  `embedded-postgres` binaries) behind the same adapter.
- **Single writer.** Throughput is lower than a pooled Postgres. Acceptable for one user; the
  team install remains the path for shared use.
- **Temporal dev server is not a production server.** Fine for one machine, and it is what
  Temporal recommends for local use; say so in the docs.
- **Download size.** The Temporal CLI and PGlite add tens of MB (to be measured).
- **Windows unknowns.** Process handling, file locking and antivirus scanning of `~/.azhi`.

## Plan and rough sizing

Estimates are inferred from reading the code, not measured.

| Step | Scope | Estimate |
|---|---|---|
| 0. Spike | PGlite adapter + Temporal dev server on Linux; `datasets`, `e2e` and `crash-suite` tests pass | 2–3 days |
| 1. Database backend | Adapter, `pglite://` URLs, transaction queue, vector extension, both-backend CI | 2–3 days |
| 2. Temporal manager | Pinned download, start/stop, health, ports | 1–2 days |
| 3. `azhi up` / `down` | One process, defaults, docs | 1–2 days |
| 4. macOS + Windows | Tree kill, Python detection, path fixes, CI matrix | 3–5 days |
| 5. Local workspace | Only after the decision above | 2–3 days |
| 6. Packaging | npm first; installers and desktop shell later | npm: 1 day; desktop: separate plan |

Steps 0–4 are roughly two to three weeks for one developer, with Windows the least certain part.

## Open decisions

1. Allow workflows to work directly on a user-chosen folder (step 5), and under what controls?
2. Is local mode free (open source) with paid hosting and team features, or part of a paid desktop
   app? This affects licensing (the repo is Apache 2.0 today).
3. Desktop shell: Tauri (smaller, Rust) or Electron (larger, all JavaScript)?

## Progress

**2026-10-04, on `dev`, tested on Linux (Ubuntu 24.04 in WSL2):**

- Step 1: `src/db/pglite.ts` puts PGlite (with `@electric-sql/pglite-pgvector`) behind the `pg`
  Pool interface; `pglite://<dir>` or `pglite://memory` selects it. The outbox and scheduler now
  open transactions through `transaction()` in `src/db/pool.ts`, which PGlite serialises (nested
  ones become savepoints).
- Step 2: `src/local/temporal.ts` downloads Temporal CLI 1.9.1 for the host platform, verifies
  its SHA-256 against pinned values, and runs `temporal server start-dev` with SQLite storage.
- Step 3: `azhi up` / `azhi down` (`src/local/up.ts`). Checked end to end: `azhi doctor` all ok
  and a Python script workflow succeeded, with no Docker. On disk: database 40 MB, Temporal state
  under 1 MB, Temporal CLI 150 MB.
- Step 4 (started): process trees are stopped with `taskkill /T` on Windows
  (`src/lib/process.ts`); Python is found as `python3`, `python` or `py -3`; OpenCode is found
  with `where` on Windows. Not yet run on native Windows or macOS.
- Tests: `npm run test:local` runs the suite on PGlite. With a Temporal dev server: 69 passed,
  8 skipped. Skipped: the crash suite and Gate 1, which run a second server process on the same
  database and so cannot use an embedded one; 2 OpenAI tests without a key. `web.test.ts` needs
  Chromium, which this machine lacks.

**2026-10-04, native Windows 11 (PowerShell, Node 24, Python 3.14):** `azhi up`, `azhi doctor`
(all ok), a Python script workflow and `azhi down` all work, and data survives a stop and restart.
Fixes it needed: the free-port check returned port 0 when the preferred port was busy; SWC's
native addon refuses `%LOCALAPPDATA%` when that folder grants rights to an app container, so
`bin/azhi.js` points `SWC_NATIVE_BINDING_CACHE` at `~/.azhi/swc-cache`; and the interpreter build
ID now ignores CRLF line endings, so a Windows checkout gets the same ID as Linux. `azhi down`
on Windows stops the process hard (no SIGTERM there); PGlite and Temporal recovered cleanly.

**Still open:** a single-process crash test for PGlite durability, macOS runs, CI on Windows and macOS, `azhi up --background`, step 5 (decision needed), and step 6.
