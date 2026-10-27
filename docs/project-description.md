# Azhi Flow: project description

Ready to paste into a project page, a video description or a submission form. Claims follow
[positioning.md](positioning.md): what is built is stated as built, the roadmap is labelled as such,
and there are no benchmark or savings figures.

## Name

Azhi Flow

## Tagline

Governed, durable agent workflows that say plainly what they can and cannot guarantee.

## One-liner

A self-hosted runtime that runs code, tools and AI agents as one durable workflow, and shows what each run saw, was allowed to do, did and cost.

## Short description (about 60 words)

Azhi Flow turns AI agent work into repeatable, governed workflows. Agents are one kind of step among
code, tools, knowledge lookups and human approvals, so a model is called only where judgment is
needed. Runs survive crashes, writes happen exactly once, and every run records what the agent saw,
what it was allowed to do, what it did and what it cost.

## Full description

### The problem

Teams that put AI agents to work run into the same things. Runs die halfway and start over. A retry
posts to Slack twice. Nobody can say what the agent was allowed to do before it ran, what it
actually saw, or why the bill jumped. Untrusted text in a pull request or ticket can steer an agent
into a write it should never make.

### What Azhi Flow does

Azhi starts from the workflow, not the agent. A workflow is a YAML file (schema 2.0) of nodes: script,
tool, agent, retrieve, condition, parallel, loop, subworkflow, approval, report and notify. Steps that
need no model, such as fetching CI data, filtering, formatting and posting, run as ordinary code and
cost no tokens. A model is called only by the agent steps.

Each run is executed durably on Temporal, so it survives restarts, retries by error class, waits for
offline workers and runs on schedules. Every external write goes through a tool gateway and an action
ledger, so killing the process mid-post still produces exactly one Slack message.

### Trust you can check

- **Run plan:** before anything executes, each requirement is marked native, bridged, unsupported or
  unverified, and a run with blockers is refused.
- **Policy coverage:** each rule is labelled enforced by Azhi, enforced by the harness, or
  unobservable.
- **Taint gate:** an ungated write after an agent that read untrusted data fails to compile. In the
  editor this is a red check, fixed by adding a guard.
- **Context manifest:** what the model saw on every turn, with sources, hashes and token counts.
- **Cost, never guessed:** usage per turn, cost from declared pricing, and "unknown" where pricing
  is not known. Per-step budgets and daily or monthly spend limits with alerts.
- **Approvals and signing:** human gates on risky steps, signed packages and worker trust policies.

### Bring your own harness

Agents run on a pluggable executor: the built-in model agent (Anthropic or OpenAI), OpenCode (with
Anthropic or GitHub Copilot models), or the Claude Agent SDK. The workflow editor builds a harness
per step: prompt, command, skills, read-only tools, MCP servers, a fresh checkout of the repository
and a budget. The run plan checks what each executor can really enforce.

### Mission Control

A web app shows what is running, waiting and failing, the approvals that need a decision, alerts,
spend, schedules and workers. Workflows are drawn as a graph that can be edited on the canvas and are
checked live by the compiler and run plan. Every run page has the graph, a replay, the action ledger,
policy coverage, context manifest and cost, live over SSE.

### Examples that ship with it

Weekly quality report to Slack with numbered citations; pull request review with parallel OpenCode
reviewers in isolated checkouts; Jira or GitHub issue to requirements, design, build, tests and a
reviewed pull request; and root-cause analysis of an issue.

## How it helps engineers save tokens

These are mechanisms that exist today, not measured savings. What you save depends on your workflow,
and Azhi reports your measured cost.

1. Steps that do not need a model never call one.
2. Tool output is projected, so agents receive the fields they need rather than whole API payloads.
3. `retrieve` returns the top-k cited passages, not a corpus.
4. Per-step budgets cap tool calls, output tokens and dollars.
5. A heavy harness and a repository checkout are created only for the step that needs them.
6. Anthropic prompt caching is used, with cache tokens counted.

## Key features

- Workflow-first runtime with eleven node types; an agent is one of them
- Durable runs on Temporal: retries, cancellation, waits, IANA-timezone schedules
- Tool gateway with action ledger and exactly-once writes
- Run plan, policy coverage, compile-time taint gate and per-turn context manifest
- Pluggable executors: built-in model agent, OpenCode, Claude Agent SDK
- Knowledge datasets with hybrid retrieval and citations
- Approvals, signed packages, per-publisher keys and worker trust policies
- Spend tracking, per-step budgets, spend limits and alerts
- CLI, REST API (local-token or OIDC), schedules and the Mission Control web app

## Built with

TypeScript on Node.js 22, Fastify, PostgreSQL with pgvector, Temporal, a React and Vite web app with
React Flow for the canvas, and Python (uv) or Bun for script nodes. Licensed under Apache-2.0.

## Status

Alpha (version 0.1.0). Server and workers are supported on Linux (Windows through WSL2); a local mode
(`azhi up`) runs everything in one process for one person. On the roadmap and not built yet:
capability-based model routing, result caching, savings reports against a baseline, capability
resolution, hosted sandboxes for coding steps, and workflows exposed as MCP tools.

## Try it

```sh
git clone https://github.com/comcast-enterprise/azhi-flow
cd azhi-flow
npm ci
npx azhi up
```

Repository: https://github.com/comcast-enterprise/azhi-flow
Demo video: `docs/demo/out/azhi-flow-demo.mp4` (about 3 minutes, sample data)
