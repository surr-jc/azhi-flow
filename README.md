# Azhi Flow

Governed, durable agent workflows that say plainly what they can and cannot guarantee.

Every run shows what the agent saw, what it was allowed to do, what it actually did, and what it cost,
and says plainly where it cannot know. See Product Specification v2.0 and the Azhi Flow Implementation
Plan for the design.

What Azhi is, the problems it solves, cost and token optimization, and how it compares with
OpenCode, VS Code agent mode and other harnesses: [docs/positioning.md](docs/positioning.md).

## Status

| Phase | State |
|-------|-------|
| 0. Spikes and kill criteria | Done: [docs/phase-0-results.md](docs/phase-0-results.md) |
| 1. Durable core | Done: [docs/phase-1.md](docs/phase-1.md) |
| 2. Agents and trust | Done: [docs/phase-2.md](docs/phase-2.md) |
| 3. Flagship workflow and alpha demo | Done: [docs/phase-3.md](docs/phase-3.md); checks 2 to 6 pass in `npm run demo`, check 1 timed in [docs/install.md](docs/install.md) |
| 4. First release | Outlined in [docs/phase-3.md](docs/phase-3.md#phase-4-first-release-outline) |

## What works today

- Workflow definitions in YAML (schema 2.0), validated and compiled with `azhi validate`: graph checks,
  ref type-checking against output schemas, tool argument and projection checks, CEL checks.
- Durable runs on Temporal: tool, script, condition, bounded parallel, report and notify nodes;
  retries by error class; cancellation; `worker_offline` waits; schedules in IANA timezones.
- A tool gateway with projection, observation records and the action ledger. Killing the process
  mid-Slack-post produces exactly one message, and `azhi inspect` shows how.
- A REST API (local-token or OIDC auth) and a Linux worker that runs Python (uv) and Bun scripts.
- The run plan (`azhi plan`): each requirement marked native, bridged, unsupported or unverified;
  policy coverage (enforced, harness, unobservable); taint paths and their gates; missing grants.
  Runs whose plan has blockers are refused before anything executes.
- Signed packages: every upload is signed with a per-publisher key certified by the workspace root.
  Workers enforce a trust policy (`self`, `authors:<ids>`, `workspace-publishers`).
- The taint rule: an ungated write after an agent that read untrusted data fails to compile.
- The built-in model agent (Anthropic or OpenAI, chosen per profile, plus a scripted provider for fixtures): gateway-only tools,
  validated output with two repairs, budgets, usage with null for unknown, a context manifest per turn.
- Approvals (`azhi approve`), knowledge datasets with hybrid retrieval and citations, and
  `azhi test-node` for one node on fixtures with writes mocked.
- The flagship weekly quality report (`azhi init`): Slack messages with numbered citations to
  immutable excerpts and per-source as-of times.
- OpenCode as a second executor, with the gateway bridged over MCP and its built-in tools off;
  `npm run compare` runs 30 fixtures through both executors and writes a report.
- Feature delivery (`examples/sdlc`): from a Jira ticket (through a Jira MCP server) or a GitHub
  issue to requirements, design, two approval gates, release and retro. Set it up with
  `azhi example install sdlc --repo OWNER/REPO --set slack_channel=... --set jira_url=...`. See
  [docs/sdlc.md](docs/sdlc.md).
- Pull request review with OpenCode agents (`examples/pr-review`): each reviewer works in its own
  fresh checkout of the PR on a worker (isolated git and HOME, read-only token never written,
  deleted after), with an agent prompt, command, skills, read-only tools and an MCP server from
  its profile, on GitHub Copilot models (your Copilot subscription, signed in with `azhi copilot login`
  or from the web UI); an approval gates the PR comment. Set up from Mission Control's Examples page or
  `azhi example install pr-review --repo OWNER/REPO`, and edit its agents in the workflow editor.
  See [docs/pr-review.md](docs/pr-review.md).
- Issue root-cause analysis with an OpenCode agent (`examples/issue-investigation`): an investigator
  in a fresh checkout of the repository, with a root-cause-analysis skill and a read-only git
  history MCP server, returns severity, complexity and confidence with reasons, a 5-whys chain with
  `file:line` evidence and a proposed fix with tests; an approval gates the issue comment.
  `azhi example install issue-investigation --repo OWNER/REPO`. See
  [docs/issue-investigation.md](docs/issue-investigation.md).
- Mission control, the web app (`azhi open`): what is running, waiting and failing, approvals to
  decide, alerts, model spend, schedules, workers, secrets (write-only) and each run's graph,
  timeline, ledger, policy coverage, context manifest and usage, live over SSE. Starting runs,
  approving and cancelling go through the same API and role checks as the CLI. Workflows are
  drawn as a graph, and authors can edit them on the canvas (add, link and change steps, checked
  live by the compiler and run plan) and save a new draft version; publishing still needs a
  signature. See [docs/mission-control-plan.md](docs/mission-control-plan.md).
- A one-command install (`deploy/install.sh`) and the six-check alpha demo (`npm run demo`).

## Install

Azhi Flow is a server stack (PostgreSQL with pgvector, Temporal and the Azhi server, all in Docker)
plus one or more **workers** that run scripts and harnesses. In the alpha, workers are supported on
**Linux only**, so on Windows you work inside WSL2 and on macOS you run a development setup.

| Platform | Supported as | How |
|----------|--------------|-----|
| Linux | Server and workers | [Linux](#linux) |
| Windows 10/11 | Everything, inside WSL2 (Ubuntu) | [Windows](#windows-wsl2) |
| macOS | Server and a development worker, not certified | [macOS](#macos) |

Common requirements: Git, Node.js 22+ and Docker with the Compose plugin. For script nodes, add
[uv](https://docs.astral.sh/uv/) (Python 3.12) and/or [Bun](https://bun.sh) on each worker host.
Documented hardware, install timings and every `deploy/install.sh` option are in
[docs/install.md](docs/install.md).

### Local mode (no Docker, experimental)

For one person on one machine, on Linux or native Windows (no WSL). `azhi up` runs an embedded
PostgreSQL (PGlite), Temporal's single-binary dev server (downloaded once into `~/.azhi/bin`,
checksum-verified), the server and a worker in one process, with all state under `~/.azhi`
(`%USERPROFILE%\.azhi` on Windows). Needs only Git and Node.js 22+, plus Python for script nodes.
The same commands work in bash and PowerShell:

```bash
git clone -b dev https://github.com/surr-jc/azhi-flow
cd azhi-flow
npm ci
npx azhi up              # prints the web UI link; Ctrl+C or `npx azhi down` to stop
```

In another terminal, `npx azhi` commands find the local server without `azhi login`, unless
`AZHI_URL`/`AZHI_TOKEN` or a saved login points elsewhere. If 7400 is taken, run
`npx azhi up --port 7410` and point the other commands at it (`export AZHI_URL=http://127.0.0.1:7410`
in bash, `$env:AZHI_URL = "http://127.0.0.1:7410"` in PowerShell). Set the model the same way
(`AZHI_ANTHROPIC_MODEL`) before `azhi up`. Limits: a single-writer database, no second server
process on the same data, and script memory limits only on Linux. macOS is not yet tested; see
[docs/local-mode-plan.md](docs/local-mode-plan.md).

### Linux

```bash
git clone https://github.com/surr-jc/azhi-flow && cd azhi-flow
npm ci
deploy/install.sh        # PostgreSQL + pgvector, Temporal and the server; prints an owner token
```

Then, on each worker host (this one or another Linux machine):

```bash
export AZHI_TEMPORAL_ADDRESS=<server>:7233       # localhost:7233 on the same machine
npx azhi login --url http://<server>:7400 --token <owner token>
npx azhi worker start --trust workspace-publishers
npx azhi doctor                                  # database, Temporal, workers online
```

### Windows (WSL2)

Native Windows is not supported: workers are Linux-only and the installer is a bash script. Run
everything inside WSL2.

1. In an admin PowerShell, run `wsl --install -d Ubuntu`, then reboot.
2. Install Docker Desktop and enable WSL integration for Ubuntu (Settings > Resources > WSL
   integration).
3. In the Ubuntu shell, install Node.js 22+ and git, then follow the [Linux](#linux) steps. Clone
   into the Linux filesystem (`~/azhi-flow`), not `/mnt/c`, which is slow and breaks file permissions.
4. Open the web run page in your Windows browser: WSL2 forwards `localhost`, so
   `http://localhost:7400` works, and `npx azhi open <run-id>` prints a ready-to-paste link.

If the page does not load, check that `docker ps` shows port 7400 published, wait about 15 seconds
after the installer, and make sure `localhostForwarding` is not disabled in `%UserProfile%\.wslconfig`.

### macOS

Docker Desktop runs the server stack on macOS, and the CLI and a worker run natively. Workers are
not certified on macOS in the alpha, and the install has not been tested on a Mac. One known
limit: script memory limits are enforced with `prlimit`, which macOS lacks, so the run plan marks
any `memory_mb` limit unsupported and refuses the run. The flagship's `metrics` script sets
`limits.memory_mb`; to run it on a Mac, remove that line from `examples/quality-report/workflow.yaml`
or use a Linux worker.

```bash
brew install node@22 git
brew install --cask docker          # start Docker Desktop once and wait until it is running
brew install uv                     # optional: Python script nodes (Bun: brew install oven-sh/bun/bun)
git clone https://github.com/surr-jc/azhi-flow && cd azhi-flow
npm ci
deploy/install.sh
export AZHI_TEMPORAL_ADDRESS=localhost:7233
npx azhi login --url http://localhost:7400 --token <owner token>
npx azhi worker start
```

For production use, run the worker on a Linux host instead. Apple Silicon works through Docker
Desktop's amd64/arm64 images, but only Linux x86-64 has been exercised.

### After installing

Add model access, then run the flagship (see the quick start below for the full sequence): store a
provider key with `npx azhi secret set anthropic-api-key --value ...` (or `openai-api-key`), and put
`AZHI_ANTHROPIC_MODEL` (or `AZHI_OPENAI_MODEL`) in `deploy/.env`, then re-run `deploy/install.sh`.

## Quick start (local development)

Runs the server from this checkout instead of the Docker image, for working on Azhi itself.
Requirements are the same as above.

```bash
npm install
npm run build:web        # the web app; rerun after pulling changes to web/

# 1. PostgreSQL + Temporal
docker compose -f deploy/docker-compose.yml up -d --wait
export AZHI_DATABASE_URL=postgres://azhi:azhi@localhost:5432/azhi
export AZHI_TEMPORAL_ADDRESS=localhost:7233

# 2. The server (API, interpreter, gateway, scheduler). In local mode it writes an owner token
#    to ~/.azhi/server/local-token, which the CLI picks up automatically.
npx azhi server start

# 3. A worker, in another terminal
npx azhi worker start

# 4. Register the example's tools and the Slack token, then run it
npx azhi apply examples/ci-digest/azhi.config.yaml
npx azhi secret set slack-bot-token --value xoxb-...
npx azhi run examples/ci-digest -i team=payments --wait
npx azhi inspect <run-id>
```

The flagship package needs a dataset and, for real model calls, a provider key and model. The
example profile uses Anthropic; set `model: {provider: openai, name: default}` in
`profiles/quality-analyst@1.yaml` to use OpenAI with `openai-api-key` and `AZHI_OPENAI_MODEL` instead.

```bash
npx azhi apply examples/quality-report/azhi.config.yaml
npx azhi dataset create quality-guidelines
npx azhi dataset add quality-guidelines examples/quality-report/knowledge
npx azhi dataset publish quality-guidelines --tag approved
npx azhi secret set anthropic-api-key --value sk-ant-...
export AZHI_ANTHROPIC_MODEL=<model id>   # set on the server; profiles say `name: default`
npx azhi plan examples/quality-report     # capabilities, coverage, taint paths, blockers
npx azhi test-node metrics examples/quality-report --fixture fixtures/metrics.json
npx azhi run examples/quality-report -i team=payments --wait
npx azhi inspect <run-id> --context analyse
```

Without a Slack workspace, point the server at a fake Slack API for local runs:
`AZHI_SLACK_API_URL=http://127.0.0.1:<port>/api` (see `src/testing/fake-slack.ts`).

To run the server in Docker instead: `docker compose -f deploy/docker-compose.yml --profile server up -d --wait`.

## CLI

| Command | What it does |
|---------|--------------|
| `azhi init [dir] [-t template]` | Create a package from a template: `quality-report` (default), `ci-digest` or `sdlc` (feature delivery with design and release gates) |
| `azhi validate [path]` | Compile a package locally; `-c azhi.config.yaml` checks tools too |
| `azhi run [path] -i k=v --wait` | Upload and run a package, streaming node results |
| `azhi publish [path]` | Publish a version; its `trigger.schedule` becomes the workflow's schedule |
| `azhi plan [path]` | The run plan: capability marks, policy coverage, taint paths, missing grants, blockers |
| `azhi test-node <node> [path] -f fixture.json` | Run one node on fixture outputs with writes mocked (a test run) |
| `azhi inspect <run> [--context <node>]` | State, flags, attempts, approvals, usage, context manifests and the action ledger |
| `azhi approve <run> <node> [--reject] [--data json]` | Decide an approval node |
| `azhi dataset create/add/publish/tag/revoke/search/list` | Knowledge datasets (Markdown and text) |
| `azhi user add/list` | Workspace users and their API tokens |
| `azhi runs`, `azhi cancel <run>` | List and cancel runs |
| `azhi apply <config>` | Register tools and schedules from an admin config; report missing secrets |
| `azhi secret set <name>` | Store an encrypted workspace secret |
| `azhi schedule <workflow> --cron ... --timezone ...` | Set or change a schedule |
| `azhi doctor` | Database, Temporal, workers online, live interpreter builds (max 3) |
| `azhi server start [--roles ...]`, `azhi server migrate` | Run the server; roles: `api,interpreter,gateway,scheduler` |
| `azhi worker start` | Run an execution worker on this host |
| `azhi login --url --token` | Save credentials for a remote server |
| `azhi open [run]` | Print a link to mission control (or one run) that signs the browser tab in |

## Tests

```bash
npm run typecheck
npm test     # unit tests; end-to-end tests run when Temporal is reachable on AZHI_TEMPORAL_ADDRESS
```

End-to-end tests create a fresh database per file on `AZHI_TEST_DATABASE_URL`
(default `postgres://azhi:azhi@localhost:5433/azhi`). `test/gate1.test.ts` is the phase 1 gate and `test/gate2.test.ts` the phase 2 gate
(refresh its golden plan with `UPDATE_GOLDEN=1` after an intended change). `test/opencode.test.ts`
runs OpenCode for real against a scripted Anthropic-compatible endpoint, and `test/web.test.ts`
drives the run page in Chromium.

```bash
npm run compare   # model agent vs OpenCode on 30 fixtures -> docs/executor-comparison.md
npm run demo      # the six alpha checks (see demo/README.md)
```

## Repository layout

```
bench/        Executor comparison: 30 fixtures and the runner
demo/         The six-check alpha demo
deploy/       Docker Compose and install.sh for the team install
docs/         Phase results and architecture decision records
examples/     Example workflow packages
migrations/   SQL migrations (source of truth for the schema)
spikes/       Phase 0 spike scripts
src/
  agents/     Model agent: profiles, providers, the tool loop, context manifests
  api/        Fastify REST API and auth
  cel/        The single CEL evaluator (compiler and runtime)
  cli/        The azhi command
  compiler/   Definition -> execution plan
  definition/ Workflow schema, YAML loader, packages
  executors/  Executor capability declarations
  gateway/    Tool gateway, executors, projection, action ledger
  knowledge/  Datasets: chunking, embedding, hybrid retrieval
  plan/       The run plan
  security/   Secrets, tokens, package signing and trust policies
  runtime/    Temporal interpreter workflow and activities
  server/     Server process, outbox, scheduler, services
  testing/    Fake Slack and Anthropic endpoints for tests, the comparison and the demo
  web/        The read-only run page
  worker/     Execution worker and script runtimes
test/         Unit and end-to-end tests
```

## License

Apache-2.0 for the core. See [LICENSE](LICENSE).
