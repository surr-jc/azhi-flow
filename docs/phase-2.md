# Phase 2: agents and trust

Goal (plan): the four trust features exist and the model agent runs under them.

## Gate 2 result

`test/gate2.test.ts` passes on Temporal + PostgreSQL 16, against the draft `examples/quality-report`
package:

1. `azhi plan` shows capabilities, policy coverage and taint paths. The output is compared with
   `test/golden/quality-report.plan.json`: `analyse` is tainted because it reads incident titles
   from a tool whose output is not marked trusted, and the path `analyse -> report -> post` is
   gated by the CEL guard on the Slack destination.
2. The same package with the guard removed fails to compile with `tainted_write_ungated` on `post`.
3. A second author signs a copy of the package. The only worker runs with the `self` policy, so the
   plan reports `worker_trust_denied`, the run is refused, and no run row is created.

## What was built

| Area | Where | Notes |
|------|-------|-------|
| Package signing, per-publisher keys under a workspace root (ADR-11) | `src/security/signing.ts`, `src/server/trust.ts`, `src/cli/signing-client.ts` | The CLI creates a key per server, workspace and user and signs every upload |
| Worker trust policies | `src/worker/worker.ts` | `azhi worker start --trust self\|authors:<ids>\|workspace-publishers`; the worker verifies again before running anything |
| Run plan | `src/plan/run-plan.ts`, `azhi plan`, `GET /v1/versions/:ref/plan` | Blockers refuse non-test runs |
| Approvals | `src/runtime/workflow.ts`, `POST /v1/runs/:id/approvals`, `azhi approve` | Role and decision-schema checks; rejection skips descendants; `on_expiry` reject or fail |
| Model agent | `src/agents/` | One activity per model turn; Anthropic adapter and a scripted provider |
| Usage and cost | `usage_records`, `azhi inspect` | Null when unknown; cost estimated only from profile pricing; completeness per run |
| Context manifest | `context_manifests`, `azhi inspect --context <node>` | Source, reason, token estimate and hash per item; content only with `AZHI_STORE_CONTEXT_CONTENT=1` |
| Knowledge datasets | `src/knowledge/`, `azhi dataset ...` | Markdown and text, immutable revisions, tags, hybrid retrieval, citations, dataset ACL, revocation |
| Test node | `azhi test-node` | Upstream outputs from a fixture; writes mocked; a `test` run |

## Decisions and defaults taken in this phase

- **Model provider: Anthropic** (the decision card in the project thread recommended it; still open for
  Suresh). Profiles say `name: default` and the server supplies the model with `AZHI_ANTHROPIC_MODEL`,
  so packages never choose a model and the run plan marks the binding unsupported until it is set.
- **Embeddings: `lexical-hash-v1`**, a deterministic feature-hashing embedder that needs no model or
  network. Retrieval quality comes mostly from full text in this setup. A real embedding model is a
  new embedder name, which means a new index revision.
- **Structured output** goes through a `submit_output` tool whose input schema is the node's output
  schema. Invalid output gets the failed fields back, twice, then the node fails `contract_violation`.
- **Taint at runtime**: besides the compile-time rule, the gateway refuses write tools called by a
  tainted agent unless the tool is `safe_for_tainted`, and records a `gateway.refused` event.
- **Dataset access** is checked as the run's creator; scheduled runs act as the version's publisher.
- **Gateway task queue** is a per-deployment setting (`AZHI_GATEWAY_QUEUE`) carried in the run snapshot,
  so two deployments can share one Temporal namespace without picking up each other's activities.

## Known limits

- Agent nodes run as one attempt; transient provider errors retry the turn, not the conversation.
- `retrieve` filters are refused (`unsupported_capability`); they arrive with document-level ACL.
- The OpenCode executor is declared for the run plan but not yet runnable (phase 3).
- The flagship's tools return fixture data; phase 3 replaces them with MCP tools.
