# Azhi Flow

Governed, durable agent workflows that say plainly what they can and cannot guarantee.

Every run shows what the agent saw, what it was allowed to do, what it actually did, and what it cost,
and says plainly where it cannot know. See Product Specification v2.0 and the Azhi Flow Implementation
Plan for the design.

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
- The built-in model agent (Anthropic, plus a scripted provider for fixtures): gateway-only tools,
  validated output with two repairs, budgets, usage with null for unknown, a context manifest per turn.
- Approvals (`azhi approve`), knowledge datasets with hybrid retrieval and citations, and
  `azhi test-node` for one node on fixtures with writes mocked.
- The flagship weekly quality report (`azhi init`): Slack messages with numbered citations to
  immutable excerpts and per-source as-of times.
- OpenCode as a second executor, with the gateway bridged over MCP and its built-in tools off;
  `npm run compare` runs 30 fixtures through both executors and writes a report.
- A read-only web run page (`azhi open <run>`): graph, timeline, ledger, policy coverage, context
  manifest and usage, updated live over SSE.
- A one-command install (`deploy/install.sh`) and the six-check alpha demo (`npm run demo`).

## Install for a team

```bash
deploy/install.sh     # PostgreSQL + pgvector, Temporal and the server, healthy, with an owner token
```

See [docs/install.md](docs/install.md) for options, documented hardware, timings and workers.

## Quick start (local)

Requirements: Linux, Node.js 22+, Docker with Compose, and for script nodes
[uv](https://docs.astral.sh/uv/) (Python 3.12) and/or [Bun](https://bun.sh).

```bash
npm install

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

The flagship package needs a dataset and, for real model calls, an Anthropic key and model:

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
| `azhi init [dir] [-t template]` | Create a package from a template (default: the quality report) |
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
| `azhi open [run]` | Print a link to the web run page that signs the browser tab in |

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
