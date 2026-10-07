# Azhi Flow local setup on Windows

Oct 7, 2026 · @Suresh

## Overview

Azhi Flow runs natively on this Windows 11 PC in local mode (no Docker) at http://127.0.0.1:7410, from the `dev` branch at commit `9ee05c8`.

| Item | Value |
| --- | --- |
| Machine | Windows 11 Home 10.0.26200, PowerShell 5.1 |
| Checkout | `C:\Users\surrj\OneDrive\Documents\Azhi-Flow\azhi-flow` |
| Branch / commit | `dev` / `9ee05c8` |
| Web UI | http://127.0.0.1:7410/ui (needs the sign-in token) |
| Temporal dev server | 127.0.0.1:7233 |
| Data folder | `C:\Users\surrj\.azhi` |
| Reference | `docs/local-mode-plan.md` in the repo |

## Prerequisites

Node.js was the only missing prerequisite; Azhi needs Node 22 or newer (`engines` in `package.json`).

| Tool | Status before setup | Action |
| --- | --- | --- |
| Git | 2.45.1 installed | none |
| Python | 3.12.5 installed | none (used by script workflows) |
| Node.js | not installed | installed 24.19.0 LTS with winget |
| npm | came with Node | 11.17.0 |
| Docker | not needed | none |

Install Node.js (run once; Windows asks for administrator approval):

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
```

Open a new PowerShell window afterwards so `node` and `npm` are on PATH, then check:

```powershell
node --version
npm --version
```

## Setup steps

Four commands in PowerShell take a fresh machine (with Node installed) to a running server. Type plain hyphens, not dashes pasted from a document.

1. Clone the repository into the project folder:

```powershell
cd C:\Users\surrj\OneDrive\Documents\Azhi-Flow
git clone https://github.com/surr-jc/azhi-flow.git azhi-flow
cd azhi-flow
```

2. Switch to the `dev` branch and pull the latest:

```powershell
git checkout dev
git pull origin dev
```

3. Install dependencies (about 2 minutes, 415 packages):

```powershell
npm install
```

4. Start local mode on port 7410 (keep this window open; it is the server):

```powershell
npx azhi up --port 7410
```

No secrets were needed to start; if a workflow later needs one, set it with `npx azhi secret set <name> --value <value>`.

## First start and verification

The first `azhi up` took a few minutes because it built the web app and downloaded Temporal; later starts skip both. It printed, in order:

1. Built the web app (its sources changed since the last build).
2. Downloaded Temporal CLI 1.9.1 (about 45 MB, once) into `~/.azhi/bin`, checksum-verified.
3. Started the Temporal dev server on 127.0.0.1:7233.
4. Applied 7 database migrations (`0001_init.sql` to `0007_agent_transcripts.sql`) to the embedded PGlite database.
5. Started the server with roles api, interpreter, gateway and scheduler on http://127.0.0.1:7410.
6. Wrote the local owner token to `C:\Users\surrj\.azhi\server\local-token`.

It ends with `Azhi is running at http://127.0.0.1:7410` and a `Web UI:` link that includes `#token=...`. To check it from a second PowerShell window:

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7410/ui).StatusCode   # expect 200
npx azhi doctor                                                          # server, database, Temporal checks
```

## Daily use

Run these from the `azhi-flow` folder; data stays in `C:\Users\surrj\.azhi` between restarts.

| Task | Command |
| --- | --- |
| Start | `npx azhi up --port 7410` |
| Print the sign-in link for the web UI | `npx azhi open` |
| Check health | `npx azhi doctor` |
| Stop | `npx azhi down` (or Ctrl+C in the server window) |
| Update to the latest dev | `git pull origin dev`, then `npm install`, then start again |

On Windows `azhi down` stops the process hard (there is no SIGTERM); the database and Temporal recover cleanly on the next start.

## Notes and troubleshooting

One item is still open: npm skipped the install scripts of 4 packages, which may affect OpenCode steps.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm warn allow-scripts` for `@swc/core`, `esbuild`, `opencode-ai`, `protobufjs` | npm 11 no longer runs install scripts until approved | `npm approve-scripts --allow-scripts-pending`, review, then `npm install` again; startup works without it |
| `node` not recognized right after installing | the current window has the old PATH | open a new PowerShell window |
| Web UI asks for a token | the browser needs the local owner token | open the link from `npx azhi open` |
| Port 7410 already in use | an earlier `azhi up` is still running | `npx azhi down`, then start again |
| npm reports a new major version (12.x) | informational | leave npm as is unless you want to upgrade |

Memory limits (`limits.memory_mb`) are Linux-only; workflows that set them are refused on Windows with a clear reason.
