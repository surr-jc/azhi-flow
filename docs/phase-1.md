# Phase 1: durable core

Goal (plan): a workflow of tool and script nodes runs durably end to end from the CLI.

## Gate 1 result

`test/gate1.test.ts` passes on Temporal + PostgreSQL 16:

1. The `ci-digest` package (tool -> script -> report -> notify) is published; its schedule fires
   (`* * * * *`, `Asia/Kolkata`) and the scheduler starts a run with occurrence ID
   `<schedule>@<occurrence time>`.
2. The gateway process is SIGKILLed after Slack accepted the post but before the receipt was recorded.
3. A new gateway process picks the Activity up, finds `dispatched` with no receipt, marks
   `outcome_unknown`, looks the message up in channel history by its dedupe key, and confirms it.
4. Slack holds exactly one message; the ledger reads `planned -> dispatched -> outcome_unknown -> confirmed`.
5. Re-firing the same occurrence does not create a second run.

The test brings the schedule's next occurrence forward rather than waiting for the minute boundary,
and uses the fake Slack API; a real-workspace run of the same path is still owed (phase 0, spike 5).

## What was built

| Area | Where |
|------|-------|
| Workflow JSON Schema 2.0, YAML loader, packages | `src/definition/` |
| Compiler: graph, refs, CEL, tool args, projections, plan | `src/compiler/` |
| PostgreSQL schema, migrator, Drizzle tables | `migrations/`, `src/db/` |
| Fastify API, local-token and OIDC auth, roles | `src/api/` |
| Outbox dispatcher, scheduler, services | `src/server/` |
| Temporal interpreter, run state machine, activities | `src/runtime/` |
| Tool gateway, ledger, projection, egress checks, executors | `src/gateway/` |
| Linux worker, Python (uv) and Bun runtimes, limits | `src/worker/` |
| CLI | `src/cli/` |

## Known limits carried into phase 2

- Node types `agent`, `retrieve` and `approval` compile but the interpreter refuses them with
  `unsupported_capability` until phase 2.
- Packages are hashed but not signed yet; worker trust policies arrive with signing in phase 2.
- The server Docker image is defined but its build could not be verified in the build environment
  (no registry access from inside `docker build`).
- `termination_unconfirmed` is not yet set: script cancellation waits for the process group to exit.
