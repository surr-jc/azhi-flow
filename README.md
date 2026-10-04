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
| 2. Agents and trust | Not started |
| 3. Flagship workflow and alpha demo | Not started |

## What works today

- Workflow definitions in YAML (schema 2.0), validated and compiled with `azhi validate`: graph checks,
  ref type-checking against output schemas, tool argument and projection checks, CEL checks.
- Durable runs on Temporal: tool, script, condition, bounded parallel, report and notify nodes;
  retries by error class; cancellation; `worker_offline` waits; schedules in IANA timezones.
- A tool gateway with projection, observation records and the action ledger. Killing the process
  mid-Slack-post produces exactly one message, and `azhi inspect` shows how.
- A REST API (local-token or OIDC auth) and a Linux worker that runs Python (uv) and Bun scripts.

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

Without a Slack workspace, point the server at a fake Slack API for local runs:
`AZHI_SLACK_API_URL=http://127.0.0.1:<port>/api` (see `src/testing/fake-slack.ts`).

To run the server in Docker instead: `docker compose -f deploy/docker-compose.yml --profile server up -d --wait`.

## CLI

| Command | What it does |
|---------|--------------|
| `azhi validate [path]` | Compile a package locally; `-c azhi.config.yaml` checks tools too |
| `azhi run [path] -i k=v --wait` | Upload and run a package, streaming node results |
| `azhi publish [path]` | Publish a version; its `trigger.schedule` becomes the workflow's schedule |
| `azhi inspect <run>` | State, flags, attempts per node, and the action ledger with every transition |
| `azhi runs`, `azhi cancel <run>` | List and cancel runs |
| `azhi apply <config>` | Register tools and schedules from an admin config; report missing secrets |
| `azhi secret set <name>` | Store an encrypted workspace secret |
| `azhi schedule <workflow> --cron ... --timezone ...` | Set or change a schedule |
| `azhi doctor` | Database, Temporal, workers online, live interpreter builds (max 3) |
| `azhi server start [--roles ...]`, `azhi server migrate` | Run the server; roles: `api,interpreter,gateway,scheduler` |
| `azhi worker start` | Run an execution worker on this host |
| `azhi login --url --token` | Save credentials for a remote server |

## Tests

```bash
npm run typecheck
npm test     # unit tests; end-to-end tests run when Temporal is reachable on AZHI_TEMPORAL_ADDRESS
```

End-to-end tests create a fresh database per file on `AZHI_TEST_DATABASE_URL`
(default `postgres://azhi:azhi@localhost:5433/azhi`). `test/gate1.test.ts` is the phase 1 gate.

## Repository layout

```
deploy/       Docker Compose for the team install
docs/         Phase results and architecture decision records
examples/     Example workflow packages
migrations/   SQL migrations (source of truth for the schema)
spikes/       Phase 0 spike scripts
src/
  api/        Fastify REST API and auth
  cel/        The single CEL evaluator (compiler and runtime)
  cli/        The azhi command
  compiler/   Definition -> execution plan
  definition/ Workflow schema, YAML loader, packages
  gateway/    Tool gateway, executors, projection, action ledger
  runtime/    Temporal interpreter workflow and activities
  server/     Server process, outbox, scheduler, services
  worker/     Execution worker and script runtimes
test/         Unit and end-to-end tests
```

## License

Apache-2.0 for the core. See [LICENSE](LICENSE).
