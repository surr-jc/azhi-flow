# Phase 0 results: spikes and kill criteria

Recorded 2026-10-04 on a 4 CPU / 15 GiB Linux 6.18 cloud container, Temporal dev server and
`temporalio/auto-setup` (latest), PostgreSQL 16 + pgvector, Node 22, `@temporalio/*` 1.24.0,
`@marcbachmann/cel-js` 8.0.0, OpenCode 1.18.34. Every spike is a script under `spikes/` and can be re-run.

| # | Spike | Script | Result |
|---|-------|--------|--------|
| 1 | Temporal team install | `spikes/01-install.sh` | **Pass.** Cold start of PostgreSQL + Temporal to healthy: 8 s. Images were already cached, so pull time (2 s) is not representative; a cold pull of the two images is the dominant cost and must be measured on the documented hardware. |
| 2 | Recovery test | `npx tsx spikes/02-recovery.ts` | **Pass.** Worker SIGKILLed at three points of a ledgered write; a fresh worker resumed each run and the target received exactly one message every time. |
| 3 | Interpreter versioning | `npx tsx spikes/03-versioning.ts` | **Pass.** In-flight run stayed on build v1 while a new run started on v2; agent loop ran 45 turns as 45 Activities over 5 executions via continue-as-new; history length stayed at 33 events. |
| 4 | CEL in TypeScript | `npx tsx spikes/04-cel.ts` | **Pass.** One environment builder serves compile-time `check()` and runtime `evaluate()`; schema-typed variables catch field typos; `now` pinned from the run snapshot is replay-safe. |
| 5 | Slack as write-dedupable | `npx tsx spikes/05-slack-dedupe.ts` | **Pass against the fake Slack API only.** Post carries the action ID in message metadata; `conversations.history` with `include_all_metadata` finds it. Needs one run against a real workspace (`SLACK_BOT_TOKEN`, `SLACK_CHANNEL`). |
| 6 | OpenCode headless | `npx tsx spikes/06-opencode.ts` | **Partial.** `opencode serve` starts headless and connects the gateway as a local MCP server. Deny rules restrict built-in tools but several (`question`, `websearch`, `skill`, `apply_patch`) need explicit rules, and OpenCode auto-allows skill directories under the user's home. Usage, structured output and cancellation need a model provider key. |

## Recovery ledger paths (spike 2)

```
crash after planned     planned@1 -> dispatched@2 -> confirmed@2
crash after dispatched  planned@1 -> dispatched@1 -> outcome_unknown@2 -> dispatched@2 -> confirmed@2
crash after send        planned@1 -> dispatched@1 -> outcome_unknown@2 -> confirmed@2
```

`@n` is the fencing generation (the Activity attempt). A transition only commits when its generation is
at least the stored one, so a stale attempt cannot overwrite a newer one.

## Gate 0 verdict

- **ADR-01 kill criteria: not triggered.** Install is far under 15 minutes and every recovery test passed.
  Temporal stays the durable engine.
- **Slack dedupe: provisionally pass.** The design holds against the API contract; confirm on a real
  workspace before Gate 1. Fallback if it fails: treat Slack as `write-unsafe` with operator reconcile.
- **OpenCode: `ambientTools: restrictable`, not `disableable`.** The adapter must deny `*` first and then
  allow only gateway MCP tools, and run OpenCode with an isolated `HOME` so no host skills or config leak
  in. Alpha check 6 only requires this to be shown honestly, which the run plan will do.

## Decisions taken from the spikes

- Interpreter builds poll their own task queue, `azhi-interpreter-<build>`; a run records its build;
  at most three builds live. See [ADR-07](adr/0007-interpreter-versioning.md).
- `now` in CEL is the run's pinned reference time (scheduled occurrence time, or creation time for manual
  runs), stored in the configuration snapshot. See [ADR-08](adr/0008-cel-now.md).
- CEL integers are BigInt; the evaluator boundary converts them to JSON numbers.

## Still open after phase 0

- Team size and calendar dates for phases 1 to 3.
- Real Slack workspace run of spike 5.
- Model provider and embedding model for the alpha (blocks phase 2 and check 6).
- Documented hardware for the 15-minute install, with a cold image pull.
