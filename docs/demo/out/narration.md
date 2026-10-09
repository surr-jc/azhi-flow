# Azhi Flow demo: narration script

Timestamps are seconds into the video.

- **0s**: Azhi Flow: governed, durable agent workflows that say plainly what they can and cannot guarantee.
- **6s**: Agents die halfway.
- **10s**: Retries post twice.
- **13s**: Nobody can say what it cost, or what it was allowed to do.
- **17s**: Azhi starts from the workflow, not the agent.
- **22s**: One screen for what is running, what needs you, and what it cost.
- **26s**: Spend is measured, never guessed.
- **30s**: Risky steps wait for a person.
- **37s**: A workflow of nodes. An agent is just one kind.
- **39s**: Only these five steps call a model.
- **43s**: Fetch, route, report and post are plain code: zero tokens.
- **49s**: Select a step to read what it does and every setting.
- **55s**: Edit on the canvas. The server compiles and plans every change.
- **60s**: Per-agent harness: executor, prompt, skills, read-only tools, MCP server and budget.
- **71s**: Add a step from the palette. Tools come from the catalog.
- **78s**: Taint rule: a write after an agent that read untrusted code will not compile without a guard.
- **90s**: Pin the write to the reviewed pull request. It compiles with no blockers.
- **98s**: What it saw, what it was allowed to do, what it did, and what it cost.
- **103s**: Replay the run, step by step.
- **112s**: Action ledger: every external write with receipts. Exactly once, even after a crash.
- **119s**: Policy coverage: what Azhi enforces itself, and what it only trusts the harness for.
- **124s**: Context manifest: every source the model saw, with hashes. Untrusted data is flagged.
- **131s**: Cost per step: nine model calls, thirty-one cents, usage known for one hundred percent.
- **138s**: Approvals carry the payload and who may decide. The decision is kept in the ledger.
- **147s**: Spend per day and per workflow: tokens in, tokens out and dollars.
- **152s**: Spend limits per workflow, per day or month. At the limit new runs are refused.
- **156s**: Unpriced turns show as unknown, never as zero.
- **160s**: How Azhi saves tokens: no model for steps that do not need one, projected tool output, top_k retrieval, per-step budgets, heavy harness only where needed, and prompt caching.
- **173s**: What Azhi does that agent runners do not: run plan, taint gate, exactly-once writes, context manifest, durable runs, and your choice of harness with signed packages.
- **188s**: Try it: azhi init, azhi up. Self-hosted. github.com/surr-jc/azhi-flow
