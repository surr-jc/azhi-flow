# Installing Azhi Flow

A team install is three containers (PostgreSQL 16 with pgvector, Temporal, the Azhi server) on
one host, plus one or more execution workers that run natively on Linux hosts. The server image
never runs scripts or harnesses; workers do.

## Documented hardware

The install was timed on this host, which is also the minimum we document for a team install:

| | |
|---|---|
| CPU | 4 vCPU (x86_64) |
| Memory | 16 GiB (the three containers use about 420 MiB idle; leave room for Temporal and PostgreSQL under load) |
| Disk | 20 GiB free (images take about 1.7 GiB, see below) |
| OS | Linux 6.x with Docker Engine 29 and the Compose plugin |
| Network | outbound HTTPS to Docker Hub (or a mirror) and the npm registry |

Image sizes on disk: `pgvector/pgvector:pg16` 631 MB, `temporalio/auto-setup:1.29.1` 788 MB,
`azhi-flow/server` 833 MB (built from `node:22-bookworm-slim`, 329 MB). Compressed downloads are
about 159 MB, 215 MB and 75 MB for the three base images.

## Server: one command

```bash
git clone https://github.com/surr-jc/azhi-flow && cd azhi-flow
deploy/install.sh
```

The script checks for Docker, Compose and openssl, writes `deploy/.env` once with a random server
secret and database password (mode 0600, git-ignored), pulls the PostgreSQL and Temporal images,
builds the server image, starts everything and waits until all three containers are healthy. It
prints the owner token at the end. Re-running it upgrades in place and keeps `deploy/.env`.

Options, all environment variables:

| Variable | Default | Use |
|---|---|---|
| `AZHI_PORT` | 7400 | API and web run page port |
| `AZHI_PG_PORT`, `AZHI_TEMPORAL_PORT` | 5432, 7233 | published ports, for workers and the CLI |
| `AZHI_TEMPORAL_VERSION` | 1.29.1 | Temporal server image tag |
| `AZHI_NODE_IMAGE` | `node:22-bookworm-slim` | base image, e.g. `mirror.gcr.io/library/node:22-bookworm-slim` when Docker Hub rate-limits |
| `AZHI_SKIP_BUILD` | unset | `1` uses an `azhi-flow/server` image that is already loaded |
| `AZHI_ANTHROPIC_MODEL`, `AZHI_OPENAI_MODEL` | unset | model for Anthropic or OpenAI agent profiles that say `name: default` |
| `AZHI_AUTH_MODE`, `AZHI_OIDC_ISSUER`, `AZHI_OIDC_AUDIENCE` | `local` | switch to OIDC for a team |
| `AZHI_COMPOSE_PROJECT` | `azhi` | run a second, isolated stack on one host |

Do not delete `deploy/.env` while the database volume exists: the database keeps the password it
was created with.

## Measured install time

Measured on 2026-10-04 on the hardware above, from a clean compose project with new volumes:

| Step | Time |
|---|---|
| Server image build (npm install of runtime dependencies) | 39 s |
| Start to all three containers healthy, fresh volumes (migrations included) | 16 s |
| `azhi doctor` with one worker online | under 1 s |

Image pulls were not measured on this host: its Docker Hub access was rate-limited, so the base
images came from a local cache and a mirror. At 50 Mbit/s the roughly 450 MB of compressed layers
take about 75 s, so a cold install fits in about 2 to 3 minutes against the 15-minute budget. An
earlier spike (`spikes/01-install.sh`, Phase 0) measured 8 s from cached images to a healthy
PostgreSQL and Temporal.

The same install then ran the CI digest example end to end with a native worker and the fake
Slack API (`AZHI_SLACK_API_URL=http://host.docker.internal:<port>/api`): the post was planned,
dispatched and confirmed in the ledger and received by the fake.

## Workers

On each Linux host that should run scripts or OpenCode nodes:

```bash
git clone https://github.com/surr-jc/azhi-flow && cd azhi-flow
npm ci --omit=dev            # includes the pinned OpenCode binary (optional dependency)
export AZHI_URL=http://<server>:7400 AZHI_TEMPORAL_ADDRESS=<server>:7233
npx azhi login --url "$AZHI_URL" --token <token>
npx azhi worker start --trust workspace-publishers
```

Script nodes need [uv](https://docs.astral.sh/uv/) (Python 3.12) and/or [Bun](https://bun.sh) on
the worker; the worker reports what it found and the run plan marks anything missing as a blocker.

## Checking the install

```bash
npx azhi doctor          # database, Temporal, interpreter builds, workers online
npx azhi open            # prints a link to the web run page that signs the browser tab in
```
