# Phase 3: flagship workflow and alpha demo

Goal (plan): pass all six live-demo checks on a fresh install.

## Gate 3 result

`npm run demo` runs the six checks with real processes: the server (API, interpreter, scheduler),
the gateway and a worker are separate `azhi` processes started from this checkout, Slack is the
bundled fake, and the analyst used a scripted Anthropic-compatible endpoint (no provider key was
available). Results from 2026-10-04 are in [alpha-demo-results.json](alpha-demo-results.json).

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Fresh install of server plus one worker under 15 minutes | Pass, measured separately | `deploy/install.sh` on fresh volumes: 24 s with cached images; image build 39 s; a worker online and `azhi doctor` green. Cold image pulls could not be timed here (Docker Hub rate limit); see [install.md](install.md) |
| 2 | `azhi plan` shows capabilities, coverage and taint paths; ungated tainted write rejected | Pass | `analyse` tainted via `incidents.list-open@1`; without the guard: `tainted_write_ungated [post]` |
| 3 | Scheduled run completes with no client attached; citations and per-source as-of times | Pass | Fired from a one-minute schedule; the Slack message has numbered citations to `quality-guidelines@1` excerpts and as-of times for ci, flaky-tests and incidents |
| 4 | Process killed during the Slack post; exactly one message; ledger shows how | Pass | Gateway SIGKILLed after the send, before the receipt; ledger `planned → dispatched → outcome_unknown → confirmed (reconciled: found on target by dedupe key)`; one message |
| 5 | `self`-policy worker refuses another author's package at plan time | Pass | Plan blocker `worker_trust_denied`; `azhi run` refused, nothing executed |
| 6 | Same 30 fixtures through the model agent and OpenCode | Pass | 30/30 contract success on all three (model agent on Anthropic, on OpenAI, and OpenCode); median node latency 0.2 s vs 6.0 s; usage complete 30/30 vs 0/30; no non-gateway tool offered to either. [executor-comparison.md](executor-comparison.md) |

What still has to happen for the alpha gate as the spec words it ("live, on a fresh install"):
run `npm run demo -- --install` once on a clean VM of the documented hardware with Docker Hub
access, and once with a real Anthropic key (`ANTHROPIC_API_KEY`, `AZHI_ANTHROPIC_MODEL`).

## What was built

| Area | Where | Notes |
|------|-------|-------|
| Flagship package | `examples/quality-report`, `azhi init` | CI runs, flaky tests and incidents (fixture tools) → metrics script → cited analysis → report → guarded Slack post |
| Citations and as-of times | `src/runtime/report.ts`, `gateway-activities.ts` | The agent may only cite excerpt IDs it was shown; the report numbers them and adds per-source as-of lines |
| Crash suite | `test/crash-suite.test.ts`, `AZHI_FAULT` | Kills the gateway at `planned`, `dispatched` and after the send; one message every time |
| OpenCode adapter | `src/worker/harness-activity.ts`, `src/agents/gateway-mcp.ts` | Pinned `opencode-ai` 1.18.34 on the worker; built-in tools off and permissions denied; the gateway bridged as a stdio MCP server; conformance suite `test/opencode.test.ts` |
| Executor comparison | `bench/`, `npm run compare` | 30 scripted fixtures in six scenarios through both executors, one Markdown + JSON report |
| Web run page | `src/web/`, `/ui/runs/:id`, `azhi open` | Read-only: graph, timeline, action ledger, policy coverage, context manifest, usage; follows the run over SSE and resumes from the last event ID |
| Run plan per run | `run.planned` event | The page shows the coverage the run had when it was created, not today's |
| Install | `deploy/install.sh`, `docs/install.md` | One command; secrets generated once; documented hardware and timings |
| Demo | `demo/`, `npm run demo` | The six checks, PASS/FAIL with evidence |

## Decisions and defaults taken in this phase

- **Model providers: Anthropic and OpenAI** (Suresh chose both on the decision card). A profile
  picks one with `model.provider`; `name: default` takes the server's `AZHI_ANTHROPIC_MODEL` or
  `AZHI_OPENAI_MODEL`, and the default credentials are `anthropic-api-key` and `openai-api-key`.
  OpenAI goes through Chat Completions; cached and reasoning tokens are recorded when reported. The
  OpenCode adapter stays Anthropic-only for now, and the run plan marks an OpenAI profile on OpenCode
  unsupported. The comparison runs the model agent on both providers.

- **The process killed in check 4 is the gateway**, because the Slack post runs there, not on a
  worker. The spec's wording ("the worker is killed") assumed the post runs on a worker; the
  recovery property it tests is the same.
- **OpenCode ambient tools are `harness` coverage**, not `enforced`: the adapter turns them off in
  OpenCode's own config and denies every permission, and the comparison checks what the model was
  actually offered. OpenCode usage is always flagged incomplete.
- **The web page holds the token in the tab only.** `azhi open` passes it in the URL fragment,
  which never reaches the server; the page clears it from the address bar and keeps it in
  `sessionStorage`. The page itself is static and unauthenticated; all data comes from the API.
- **Fixture tools stand in for real MCP servers** in the flagship. The plan's default for real
  systems is GitHub Actions for CI and GitHub Issues for incidents; that waits on the design
  partners' answer.
- **Temporal is pinned to 1.29.1** in the install, and the server image no longer ships OpenCode.

## Known limits

- The comparison uses a scripted model, so it measures adapter behaviour (contract, latency,
  cost accounting, tool exposure), not model quality. OpenCode's latency is dominated by starting
  `opencode serve` per node.
- The run page has no write actions (approve, cancel); those stay in the CLI.
- The fresh-install check has not been run on a clean VM with cold image pulls.

## Phase 4: first release (outline)

From the plan, to be detailed after the alpha gate and design-partner feedback:

1. **Real data sources for the flagship**: GitHub Actions and GitHub Issues as MCP tools (or the
   partners' systems), replacing the fixture tools.
2. **More executors**: Claude Agent SDK and Codex adapters, each with a pinned version and a
   conformance run like OpenCode's; Streamable HTTP MCP in the gateway.
3. **Workflows as MCP tools** (the spec's second workflow), so a developer's coding agent can call
   a published workflow.
4. **Graph features**: loops, subworkflows, quorum joins.
5. **Channels**: Slack commands and buttons (approvals from Slack), web chat and a visual editor.
6. **Knowledge**: more dataset formats and document-level ACL.
7. **Operations**: `azhi migrate`, `export`, `rerun`; the 100-case benchmark that the system
   targets in spec section 14 depend on.
