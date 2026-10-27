# Azhi Flow: what it is, what it solves, and where it fits

Status: positioning report, 6 October 2026. Every capability below is labelled:

- **Built**: in the code on `dev` today, with the file or doc that shows it.
- **Partly built**: a working piece exists, but not the full idea.
- **Vision**: not built. A direction, not a promise.

No benchmark numbers or savings percentages appear here as facts. Where a figure is shown, it is
marked as an illustrative example.

## In one sentence

Azhi Flow is a self-hosted runtime for AI workflows: deterministic code, agents, MCP tools,
knowledge and human approvals run as nodes of one durable, governed workflow, and every run shows
what the agent saw, what it was allowed to do, what it did and what it cost.

The longer-term ambition is an **execution fabric**: one portable workflow definition whose models,
tools, knowledge and execution environments are replaceable parts the runtime picks and optimizes.

## The core idea: workflow-first, not agent-first

Most agent tools start from an agent and hand it tools:

```
Agent → tools → task
```

Azhi starts from a workflow, and an agent is only one kind of node:

```
Intent → workflow → code / tools / MCP / knowledge / agents / approvals → result
```

None of the individual features is unique on its own. Visual workflows, coding agents, MCP, model
routing, observability and RAG all exist elsewhere. What can be distinctive is treating all of them
as replaceable parts of the same execution system, with governance and cost accounting built into
the runtime rather than added afterwards.

The practical payoff: steps that do not need a model (fetching CI data, parsing, filtering,
formatting, posting) run as ordinary code, and the LLM is called only where judgment is needed.

## Key problems it solves

| Problem teams hit with agents today | How Azhi answers it | State |
|---|---|---|
| Agent runs die halfway (crash, restart, timeout) and redo or lose work | Durable runs on Temporal: retries by error class, cancellation, waits for offline workers, schedules | Built |
| A retried agent posts twice or writes twice | Tool gateway with an action ledger and effect classes; killing the process mid-Slack-post yields exactly one message (`azhi inspect` shows why) | Built |
| Nobody can say what the agent was allowed to do before it ran | The run plan (`azhi plan`): each requirement marked native, bridged, unsupported or unverified; runs with blockers are refused before anything executes | Built |
| Policies that look enforced but are not | Policy coverage labels each rule enforced, harness-enforced or unobservable, per executor | Built |
| Prompt injection from untrusted data flowing into writes | Taint rule: an ungated write after an agent that read untrusted data fails to compile | Built |
| "What did the model actually see?" | A context manifest per turn (items, sources, token counts, what is unobservable) | Built |
| Surprise model bills | Usage per turn (input, output, cache read/write, reasoning tokens), cost from declared pricing or "unavailable" (never guessed), per-step `max_cost_usd`, daily/monthly spend limits with alerts | Built |
| Copilot subscription cost is opaque | Copilot steps counted in AI credits against the monthly pool, `azhi copilot quota` and the run page show the allowance | Built (rates from published tables; see `src/agents/copilot-pricing.ts`) |
| Being locked to one agent harness | Executors are pluggable: built-in model agent, OpenCode, Claude Agent SDK; each declares its capabilities and the run plan checks them | Built (Codex adapter experimental, off by default) |
| Being locked to one model vendor | Profiles choose Anthropic, OpenAI or GitHub Copilot; `name: default` lets each server pick the model | Built |
| Human sign-off on risky steps | Approval nodes, `azhi approve`, approvals in Mission Control | Built |
| Answers without sources | Knowledge datasets with hybrid retrieval (full text + vectors) and numbered citations to immutable excerpts | Built (alpha embedder is lexical-hash, not a neural model) |
| Untrusted workflow code on workers | Signed packages, per-publisher keys, worker trust policies | Built |

## What exists today

All of this is on `dev` unless noted. See the [README](../README.md#what-works-today) for the full list.

- **Workflow definitions** in YAML (schema 2.0), compiled with graph, type, CEL and taint checks.
  Node types: `script` (Python via uv, Bun), `tool`, `agent`, `retrieve`, `condition`, `parallel`,
  `loop`, `subworkflow`, `approval`, `report`, `notify` ([src/definition/types.ts](../src/definition/types.ts)).
- **Loops and subworkflows**, so a workflow can call another workflow
  ([docs/loops-and-subworkflows.md](loops-and-subworkflows.md)).
- **Trust features**: run plan, policy coverage, action ledger, context manifest
  ([src/plan](../src/plan), [src/compiler/taint.ts](../src/compiler/taint.ts)).
- **Executors** with declared capabilities ([src/executors/capabilities.ts](../src/executors/capabilities.ts)):
  model agent (Anthropic, OpenAI), OpenCode (Anthropic, GitHub Copilot), Claude Agent SDK (Anthropic).
  `npm run compare` runs 30 fixtures through two executors ([docs/executor-comparison.md](executor-comparison.md)).
- **Harness builder** in the workflow editor: per-step executor, agent prompt, command, skills,
  read-only tools and MCP servers for OpenCode reviewers.
- **Isolated coding workspaces**: an agent step can get a fresh git checkout on a worker, with
  isolated git and HOME, deleted after the step ([docs/pr-review.md](pr-review.md)).
- **MCP**: tools can be MCP servers over stdio, called through the gateway; the gateway is bridged
  into harnesses over MCP.
- **Knowledge**: datasets with hybrid retrieval and citations; `retrieve` nodes and agent `datasets`.
- **Cost and usage**: per-turn usage records, cost from profile pricing, Anthropic prompt caching
  on the system prompt with cache tokens counted, step budgets, spend limits, Copilot AI-credit
  accounting ([src/server/budgets.ts](../src/server/budgets.ts)).
- **Entry points**: CLI, REST API, schedules, Mission Control web app.
- **Examples**: weekly quality report to Slack, PR review with OpenCode reviewers, SDLC from a
  Jira ticket or GitHub issue ([docs/sdlc.md](sdlc.md)).

## Cost and token optimization

### Built today

1. **Not every step is an LLM call.** Script, tool, condition, retrieve, report and notify nodes run
   without a model. A well-designed Azhi workflow spends tokens only on agent nodes.
2. **Lightweight versus heavyweight execution.** Ordinary steps run in the interpreter or as
   scripts. A full coding harness (OpenCode, Claude Agent SDK) and a cloned workspace are created
   only for the step that needs them, behind a `condition` if you want.
3. **Bounded context.** `retrieve` takes `top_k`; tool outputs pass through projections, so agents
   receive the fields they need rather than whole API payloads.
4. **Budgets.** Agent steps accept `max_output_tokens`, `max_tool_calls` and `max_cost_usd`;
   profiles accept `max_turns`. The run plan says whether each cap is enforced or only estimated.
5. **Spend limits** per workspace or workflow, per day or month, with alerts.
6. **Honest accounting.** Cost is shown only when pricing is known; otherwise it is labelled
   unavailable and spend limits say they are a lower bound.
7. **Prompt caching** on the Anthropic system prompt, with cache read and write tokens recorded.

### Vision (not built)

The pipeline below is the target, not current behavior:

```
Request
  → cached result?                     (vision: result cache)
  → deterministic step possible?       (today: chosen by the author, not the runtime)
  → small model sufficient?            (vision: capability routing)
  → retrieve only the context needed   (partly built: top_k, projections)
  → large model only if necessary
```

- **Automatic model selection** by capability and strategy (`capability: coding`,
  `strategy: cost_optimized`). Today the profile names a provider and model.
- **Result caching** of repeated steps across runs.
- **Savings reporting** against a naive all-agent baseline. An illustrative example of what this
  could show (made-up numbers, not a measurement): "Workflow cost $0.21, estimated naive agent
  execution $1.84". Producing this honestly needs a defined baseline per workflow; until then Azhi
  reports only measured cost.

## The bigger ideas: what is built and what is vision

| Idea | State | What exists now |
|---|---|---|
| Workflow-first, agent is one node | **Built** | Eleven node types; agents are one of them |
| One workflow, several execution modes (cheap workflow steps, sandboxed coding only when needed) | **Partly built** | `condition` + agent `workspace` checkout + harness executors. No GitHub-hosted or container sandbox provider yet |
| Provider independence | **Partly built** | Anthropic, OpenAI, Copilot per profile; `name: default` per server. Not capability-based |
| Capability-based model routing (`model: auto`) | **Vision** | none |
| Portable agents (an Azhi Agent Contract reused across workflows and providers) | **Partly built** | Versioned profiles (instructions, model, limits, harness setup) are reusable within a package; executor capabilities are declared. No standalone agent registry with capabilities, tools and knowledge in one contract |
| MCP as a first-class runtime primitive | **Partly built** | MCP stdio tools through the gateway with ledger and policy; gateway bridged into harnesses. Streamable HTTP MCP, health, latency and cost metadata are pending |
| Capability resolution (`requires: issue-management` → Jira MCP or Linear MCP) | **Vision** | Tools are registered by name and revision |
| Knowledge as a uniform interface for any node | **Partly built** | Datasets with hybrid retrieval and citations; Git, MCP resources, databases and web sources are not knowledge sources yet |
| Token optimization as part of execution | **Partly built** | See the section above |
| One execution graph for chat, automation and coding | **Partly built** | CLI, API, schedule and web entry points into one runtime; coding harnesses are nodes. No web chat or webhook triggers yet |
| Capability Graph (runtime builds the execution path from available capabilities, permissions, cost, health) | **Vision** | The run plan already evaluates requirements against executor capabilities, which is the seed of this |
| Workflows exposed as MCP tools | **Vision** (pending) | none |

## How Azhi compares

As of 6 October 2026, from each product's public descriptions. These tools change quickly; check
their current docs before relying on a row. Azhi is not a replacement for an in-editor assistant:
several of these tools can run *inside* Azhi as executors.

| | Azhi Flow | OpenCode | VS Code + Copilot agent mode | Claude Code / Agent SDK | n8n-style automation | LangGraph-style frameworks |
|---|---|---|---|---|---|---|
| Primary shape | Self-hosted workflow runtime | Terminal/coding agent | Agent inside the editor | Coding agent (CLI) and SDK | Visual automation with AI nodes | Code library for agent graphs |
| Unit of work | Workflow (agent is one node) | Agent session | Chat/agent session | Agent session | Workflow | Graph in code |
| Durable runs, retries, schedules | Yes (Temporal) | No (interactive sessions) | No | No built-in scheduler | Yes | Checkpointing; scheduling depends on deployment |
| Many model providers | Anthropic, OpenAI, Copilot today | Yes, many | Models offered by your Copilot plan | Claude models | Many, via nodes | Many |
| MCP | stdio tools via a governed gateway | Yes | Yes | Yes | Available | Via adapters |
| Pre-run plan of what is enforced vs not | Yes (run plan, policy coverage) | No | No | No | No | No |
| Exactly-once writes ledger | Yes | No | No | No | No | No |
| Taint check for injected data | Yes, at compile time | No | No | No | No | No |
| Per-turn context manifest | Yes | No | No | No | No | No |
| Cost per step, budgets, spend limits | Yes | Shows usage per session | Plan-level premium usage | Usage and cost reporting | Varies | Via separate tracing tools |
| Human approval gates | Yes | Per-tool permission prompts | Per-tool confirmation | Per-tool permission prompts | Yes | Yes (interrupts) |
| Best at | Repeatable, governed team workflows | Interactive coding, any model | Coding where you already work | Interactive and headless coding | Integrations glue | Custom agent apps in code |

Where Azhi fits with them:

- **OpenCode** and the **Claude Agent SDK** are Azhi executors today. Azhi adds what they leave to
  the user: durability, scheduling, approvals, the action ledger, taint checks and cost limits.
- **VS Code agent mode** is the right tool for a developer working interactively. Azhi is for the
  same kind of work run repeatedly, unattended and auditable (a weekly report, every PR review, a
  ticket-to-release flow).
- **n8n-style tools** are strong on integrations; Azhi's difference is treating agents as governed,
  measured nodes with explicit guarantees.
- **LangGraph-style frameworks** give building blocks in code; Azhi is an opinionated runtime with
  a declarative definition, compile-time checks and an operations UI.

## Positioning statement

Avoid: "another AI workflow builder".

Prefer: **Azhi Flow is an execution fabric for AI workflows. It runs deterministic code, agents,
MCP tools and organizational knowledge through one portable workflow definition, and tells you
before and after each run what was guaranteed, what was seen and what it cost.**

The second half ("automatically optimizing models, context, cost and execution environments") is
the roadmap, and should be claimed only as each piece ships.

## Suggested next steps toward the vision

1. Capability fields on profiles (`capability`, `strategy`) resolved by a simple router over the
   existing providers, with the choice recorded in the run plan.
2. Streamable HTTP MCP and tool metadata (permissions, health, latency, cost) in the registry.
3. A savings report with an explicit, per-workflow baseline definition.
4. Web chat and webhook entry points into the same runtime.
5. A container or hosted sandbox provider for coding steps, alongside the worker checkout.
6. Capability resolution (`requires:`), then the Capability Graph built on the run plan.
