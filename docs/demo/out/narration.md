# Azhi Flow demo: narration script

Timestamps are seconds into the video.

- **0s**: Azhi Flow: governed, durable agent workflows that say plainly what they can and cannot guarantee.
- **6s**: Agents die halfway.
- **9s**: Retries post twice.
- **12s**: Nobody can say what it cost, or what it was allowed to do.
- **16s**: Azhi starts from the workflow, not the agent.
- **20s**: One screen for what is running, what needs you, and what it cost.
- **24s**: Spend is measured, never guessed.
- **28s**: Risky steps wait for a person.
- **34s**: A workflow of nodes. An agent is just one kind.
- **36s**: Only these five steps call a model.
- **40s**: Fetch, route, report and post are plain code: zero tokens.
- **45s**: Select a step to read what it does and every setting.
- **51s**: Edit on the canvas. The server compiles and plans every change.
- **56s**: Per-agent harness: executor, prompt, skills, read-only tools, MCP server and budget.
- **66s**: Add a step from the palette. Tools come from the catalog.
- **72s**: Taint rule: a write after an agent that read untrusted code will not compile without a guard.
- **83s**: Pin the write to the reviewed pull request. It compiles with no blockers.
- **91s**: What it saw, what it was allowed to do, what it did, and what it cost.
- **95s**: Replay the run, step by step.
- **104s**: Action ledger: every external write with receipts. Exactly once, even after a crash.
- **110s**: Policy coverage: what Azhi enforces itself, and what it only trusts the harness for.
- **115s**: Context manifest: every source the model saw, with hashes. Untrusted data is flagged.
- **121s**: Cost per step: nine model calls, thirty-one cents, usage known for one hundred percent.
- **128s**: Approvals carry the payload and who may decide. The decision is kept in the ledger.
- **136s**: Spend per day and per workflow: tokens in, tokens out and dollars.
- **141s**: Spend limits per workflow, per day or month. At the limit new runs are refused.
- **145s**: Unpriced turns show as unknown, never as zero.
- **148s**: How Azhi saves tokens: no model for steps that do not need one, projected tool output, top_k retrieval, per-step budgets, heavy harness only where needed, and prompt caching.
- **160s**: What Azhi does that agent runners do not: run plan, taint gate, exactly-once writes, context manifest, durable runs, and your choice of harness with signed packages.
- **174s**: Try it: azhi init, azhi up. Self-hosted. github.com/surr-jc/azhi-flow
