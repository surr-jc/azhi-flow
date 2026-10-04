# Azhi Flow

Governed, durable agent workflows that say plainly what they can and cannot guarantee.

Every run shows what the agent saw, what it was allowed to do, what it actually did, and what it cost,
and says plainly where it cannot know. See Product Specification v2.0 and the Azhi Flow Implementation
Plan for the design.

## Status

| Phase | State |
|-------|-------|
| 0. Spikes and kill criteria | Done: see [docs/phase-0-results.md](docs/phase-0-results.md) |
| 1. Durable core | Not started |
| 2. Agents and trust | Not started |
| 3. Flagship workflow and alpha demo | Not started |

## Requirements

- Linux, Node.js 22+, Docker with Compose
- Python 3.12 + [uv](https://docs.astral.sh/uv/) and [Bun](https://bun.sh) for script nodes (phase 1)

## Running the phase 0 spikes

```bash
npm install

# PostgreSQL + Temporal
docker compose -f deploy/docker-compose.yml up -d --wait
export AZHI_DATABASE_URL=postgres://azhi:azhi@localhost:5432/azhi
export AZHI_TEMPORAL_ADDRESS=localhost:7233

./spikes/01-install.sh              # timed cold install (uses its own throwaway project)
npx tsx spikes/02-recovery.ts       # kill a worker mid-write; exactly one message
npx tsx spikes/03-versioning.ts     # interpreter builds and continue-as-new
npx tsx spikes/04-cel.ts            # CEL check/evaluate, pinned `now`
npx tsx spikes/05-slack-dedupe.ts   # fake Slack, or real with SLACK_BOT_TOKEN + SLACK_CHANNEL
npx tsx spikes/06-opencode.ts       # OpenCode headless with the gateway bridged over MCP
```

## Repository layout

```
deploy/      Docker Compose for the team install
docs/        Phase results and architecture decision records
spikes/      Phase 0 spike scripts
src/         Platform source (TypeScript)
```

## License

Apache-2.0 for the core. See [LICENSE](LICENSE).
