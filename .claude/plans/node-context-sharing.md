# Feature: Generic node-to-node context sharing

The following plan should be complete, but validate documentation and codebase patterns and task sanity before you start implementing. Pay special attention to the naming of existing types and helpers (`Value`, `PlanNode`, `WORKSPACE_CHANGE_SCHEMA`, `AgentBeginInput`, `Checkout`, `WorkerCapabilities`). Branch: `dev`. Conventional commits (`feat:`, `docs:`). Nothing merges, closes or force-pushes.

**Revision 4 (2026-10-29).** Revision 3 was checked against the code at `dev` `2d99c8e` once more. That found one correctness bug in the bundle design, a skip rule that would warn on almost every step, a fragile SHA check in continuation, and an unplanned use case that matters more than the fix rounds. The work is now **three independent PRs**, shipped in this order: **A. input cap -> B. workspace continuation -> C. context bundles**. Each PR has its own tasks, tests and acceptance criteria, and ships even if a later one slips. See "What changed in revision 4" at the end. Confidence tags: **[Certain]** = read in code or reproduced; **[Likely]** = strong inference; **[Guessing]** = not verified.

## Feature Description

Nodes already share data through explicit refs (`ref: nodes.X.output.field`, CEL). This feature adds three **opt-in, definition-level** mechanisms any workflow can adopt from YAML upload, "Build with chat", or the visual editor:

1. **Input cap (PR A).** On an agent node, `context_budget` limits the bytes of input that reach the model. By default a breach **fails** the step. Withholding a field instead is a per-node opt-in that is recorded and shown to people.
2. **Workspace continuation (PR B).** `workspace.from: {ref: …}` starts a checkout from an earlier change. The worker fetches the change's own `base_sha` and applies the earlier files **as a local commit**. This works in **read mode** (reviewers and verifiers inspect the real changed code) and in write mode (fix rounds build on the previous change).
3. **Context bundles (PR C).** A workflow-level `contexts:` block names a set of upstream values once, and nodes list `context: [name]`. The compiler **expands bundles statically into the node's `input`**, so the runtime is unchanged.

**Why this order.** It goes from the best ratio of value to risk to the worst:

| PR | Value | Surface | Confidence |
|---|---|---|---|
| A | A cost and safety guard for every executor | One pure function, the manifest, settings, a run event | 9/10 |
| B | Reviewers check the code they review; fix rounds stop re-typing the change; Temporal payloads stay small | Worker git, path safety, feature gating, server lookup | 8/10 |
| C | Easier editing, with a moderate reduction in duplication (see the problem statement) | Compiler, taint, editor graph, drawer, settings, builder | 7/10 |

The input cap and continuation work well together. A capped reviewer whose diff is withheld can still read the change in its checkout. This answers the reviewer hazard in D5.

**Not in v1:**
- Handoff notes. An author can declare a `notes` string in `output_schema` instead. Handoff notes would also reserve an engine-owned field name and open an injection channel.
- Shared memory or a blackboard, transcript inheritance, an LLM "summary" mode, and passing all upstream outputs automatically.
- Bundles with parameters.
- Bundles on `subworkflow` and on `merge: any` nodes.
- Named or default `workspace:` blocks. This is a follow-up; see "Follow-ups".

## User Story

As a workflow author (YAML, Build with chat, or visual editor)
I want to cap how much input reaches a model, let a later agent work in a checkout that already contains an earlier agent's change, and declare once which upstream values several steps need
So that multi-step workflows cost less, reviewers check real code, and workflows stay consistent when edited, without losing their taint, approval and audit guarantees.

## Problem Statement (verified)

- `materialise()` (`model-agent.ts:172`) expands every input artifact in full. Only *output* tokens are budgeted, and the manifest records the whole input as one item (`model-agent.ts:220`). [Certain]
- **Reviewers and verifiers check code that doesn't contain the change.**
  - `lite_review_2` and `lite_verify_2` check out the base branch (`depth: 1`) and get the change only as diff text (`examples/ai-sdlc-v2/workflow.yaml:726-776`). The same holds for round 1 and for the standard and full paths.
  - The verifier is told to "try to refute findings in a fresh checkout". That checkout lacks the code being checked. [Certain]
- Fix rounds pass `previous_diff` as prompt text into a fresh base checkout, and the agent has to re-type the change (`implement-change/SKILL.md:22-24`). [Certain]
- A write-mode harness returns its whole change (up to 1 MB of file contents) as an activity result in workflow history (`harness-activity.ts:406`, `workflow.ts:207`). Passing it on by value would copy it again. [Certain]
- Duplication in `examples/ai-sdlc-v2/workflow.yaml`:
  - The `workspace:` block (repo, ref expression, credential) repeats identically on about 12 agents. This is the largest duplication, and **bundles do not address it** (follow-up). [Certain]
  - The `build`, `build_static` and `build_untested` inputs are identical (`:440`, `:466`, `:498`). [Certain]
  - Review and verify pairs repeat `requirements`, `design` and the six-field `change` object within each round. The rounds differ (`change_1` against `change_2`), so a bundle covers one round, not all of them. [Certain]
- YAML anchors don't solve the duplication:
  - Merge keys (`<<`) are not enabled. A `<<` key silently becomes a literal input key (reproduced).
  - The visual editor re-serialises the definition as JSON (`Editor.tsx:200`, `:247`), so aliases are lost on the first visual edit. [Certain]
- The builder can't author any of this, and it now edits existing workflows by patch. [Certain]

## Shared decisions

| # | Decision | Evidence / reason |
|---|---|---|
| S1 | Every mechanism is optional, is declared in `src/definition/schema.ts`, and leaves workflows that don't use it compiling to **byte-identical plans**. | Regression baseline (below) plus the `gate2` golden. [Certain about the mechanism] |
| S2 | Runs are pinned to the interpreter build that created them (`runs.ts:100`, `outbox.ts:102`). Activity inputs change only additively. | An older build simply ignores new optional fields. The consequences are covered under "Deployment constraint". [Certain] |
| S3 | Unknown values stay unknown. Caps are exact bytes. Token figures, where shown, are labelled `estimated`. | Repository rule. [Certain] |

**Regression baseline (before PR A, reused by B and C).** Compile every package under `examples/` and `test/fixtures/` with the current compiler, and store each plan JSON under `test/golden/context-regression/`. `test/context-regression.test.ts` (created in PR A) asserts byte equality for every workflow that doesn't use the new keys.

---

# PR A: Input cap (`context_budget`)

## Decisions

| # | Decision | Evidence / reason |
|---|---|---|
| A1 | `context_budget: {max_item_bytes?, max_input_bytes?, on_exceed?: fail \| withhold}` on agent nodes. **Bytes, not tokens.** Default `on_exceed: fail` (`budget_exceeded`). | A token cap would be enforced on a `chars/4` guess (`model-agent.ts:135`), which breaks the "never guessed" rule. Silent withholding by default could let a reviewer "approve" a diff it never saw. [Certain about the mechanism; the hazard is Likely] |
| A2 | Sizes are measured as `Buffer.byteLength(JSON.stringify(value), 'utf8')` per top-level input key (item) and over the whole materialised input (total), **after** `materialise`. | Artifact handles and `$artifact_path` refs expand in `materialise`, so a cap applied earlier would measure handles, not content. [Certain] |
| A3 | Withheld values are **not** stored again. The manifest records the hash and size only. | They already exist as upstream outputs, and the agent has no tool to read artifacts. Storing them again would persist data even when `AZHI_STORE_CONTEXT_CONTENT` is off. [Certain] |
| A4 | The cap applies in `agentBegin`, which covers the model agent **and every harness executor**. | Harnesses take `prep.prompt` from `harnessPrepare` -> `agentBegin` (`workflow.ts:164-194`, `model-agent.ts:462`). [Certain] |
| A5 | The retrieval query is not affected: `withChunksFor` keeps building the query from the raw input, which is resolved before the cap (`gateway-activities.ts:380-393`). | No change needed in PR A. PR C adds the guard for bundle keys. [Certain] |
| A6 | The workspace-wide default is a server env setting, off by default. The server default's `on_exceed` is always `fail`. | Settings pattern at `settings.ts:63`. A Governance UI setting is a follow-up. |
| A7 | When a field is withheld: the activity result carries `withheld`, the workflow records a `context_withheld` run event and flag (mirroring `usage_incomplete`, `workflow.ts:204`), and the run page and approval context show it. | The people approving must know what an agent did not see. [Certain about the pattern] |

## Tasks

### A1. UPDATE `src/definition/types.ts` and `src/definition/schema.ts`
- **IMPLEMENT**: `AgentNode.context_budget?: { max_item_bytes?: number; max_input_bytes?: number; on_exceed?: 'fail' | 'withhold' }`. Schema: `max_item_bytes` is an int >= 256, `max_input_bytes` an int >= 1024, `on_exceed` an enum; set `minProperties:1` and allow no extra keys.
- **GOTCHA**: `node()` sets `additionalProperties:false`, so the key must be listed on the agent node. Older servers reject it (fail closed), which is desired.
- **VALIDATE**: `npm run typecheck && npx vitest run test/compiler.test.ts`

### A2. CREATE `src/agents/context-budget.ts`
- **IMPLEMENT** the pure function `applyContextBudget(input, {maxItemBytes?, maxInputBytes?, onExceed})`. It returns `{input, withheld: [{key, bytes, sha256}]}` or throws `AzhiError(ErrorClass.budgetExceeded, …)`; the error names the node, the key and the numbers.
  - With no limits set, it returns the same object reference.
  - `fail` throws on any breach.
  - `withhold`:
    1. Replace each top-level key above `maxItemBytes` with `{note: "withheld: <n> bytes, above this step's context_budget; you cannot read it. Say so if it matters to your result.", bytes, sha256}`.
    2. While the total is above `maxInputBytes`, withhold the largest remaining key; ties break by key order.
    3. If the total is still over, throw.
  - An input that isn't an object (a scalar or an array) is measured whole: `fail`, or throw for `withhold`, because no single key can be withheld.
  - It never calls storage.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts`

### A3. UPDATE `src/agents/model-agent.ts`, `src/config/settings.ts`, `src/runtime/workflow.ts`
- **IMPLEMENT**:
  - `AgentBeginInput.contextBudget?`. `workflow.ts` passes `def.context_budget` into `agentBegin` (`:224`) and `harnessPrepare` (`:164`).
  - `settings.contextBudget` from `AZHI_CONTEXT_MAX_ITEM_BYTES` and `AZHI_CONTEXT_MAX_INPUT_BYTES`. Both are unset by default. Invalid values are ignored with a startup warning. Node limits override the server values key by key.
  - In `agentBegin`: `materialise`, then `applyContextBudget`. When anything is withheld, add one manifest item per withheld key: kind `input`, the reason `withheld by context_budget (<n> bytes)`, and the hash. Never the content.
  - Return `withheld` in the begin and prepare results. The workflow records `context_withheld` (event plus flag).
  - Show it on the run page next to `usage_incomplete`, and in the approval context of any approval downstream of the step.
- **GOTCHA**: Without a budget, the manifest and the prompt must stay byte-identical to today's.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts test/agent.test.ts && npm run typecheck`

### A4. Authoring surfaces for A
- `src/plan/run-plan.ts`: a row for each capped node with its limits and `on_exceed` mode.
- `web/src/pages/Editor.tsx`: an **Input cap** group on agent nodes (two byte fields and an `on_exceed` select that defaults to fail, next to `setBudget` at `:810`). Add help strings to `web/src/stepHelp.ts`.
- `src/builder/skill.md`: a reference entry, plus one line in "Policies and controls to offer": cap inputs that can be large; fail is the default; withhold only where the step can do without the field.
- **VALIDATE**: `npx vitest run test/gate2.test.ts test/editor.test.ts test/builder.test.ts && npm run build:web`

### A5. Tests and docs
- `test/context-budget.test.ts`:
  - `fail` is the default.
  - `withhold` goes largest first, with a stable tie-break.
  - Still over the total -> error.
  - Non-object inputs.
  - Same reference returned when no limits are set.
  - No storage calls (spy on `ctx.artifacts`).
- A Temporal run with the scripted provider:
  - A withheld field shows the `context_withheld` event and flag.
  - `fail` mode fails with `budget_exceeded`.
  - The manifest has no content for withheld keys.
- Also run `test/context-regression.test.ts` (baseline).
- Create `docs/context-sharing.md` with the input-cap section (style: `docs/loops-and-subworkflows.md`): semantics, error codes, the two modes, the reviewer hazard, and the env settings.

## Acceptance (PR A)
- [ ] Exact-byte caps, fail by default, applied after `materialise`, covering the model agent and all harness executors.
- [ ] A withheld field is recorded (event, flag, manifest hash) and shown on the run page and in approval context. It is never stored again.
- [ ] Workflows without `context_budget` compile and run byte-identically (manifest included).
- [ ] `npm run typecheck`, `npm run test:local` and `npm run build:web` pass.

---

# PR B: Workspace continuation (`workspace.from`)

## Decisions

| # | Decision | Evidence / reason |
|---|---|---|
| B1 | `workspace.from` must be a plain `{ref: 'nodes.<id>.output…'}` whose schema is `compatible` with `WORKSPACE_CHANGE_SCHEMA`. Any node type can produce it (for example a `change_N` selector script). Both **read and write mode** are allowed. An untyped producer gets a warning plus a run-time check. | The content is untrusted wherever it comes from. Safety comes from run-time validation (schema, path rules) and from the fact that nothing pushes without a gate. [Likely] |
| B2 | **The worker pins the base itself.** With `from` set, the worker fetches `from.base_sha` (the commit the change was made against) instead of the step's `ref`. The step's `ref` is kept only to label the collected change (`collectChange` meta, `harness-activity.ts:404`). Setting `base_ref` together with `from` is a compile error. | A step's `ref` is usually a branch expression (ai-sdlc uses the base branch head with `depth: 1`). A push to that branch during a long run would make "head must equal base_sha" fail for no real reason. Pinning removes that failure entirely. Fetch-by-SHA: GitHub allows it; the test server is `git http-backend` with the client's `GIT_PROTOCOL` passed through (`src/testing/fake-git.ts:24-35`), and protocol v2 accepts any reachable SHA in `want`. [Likely: Task B4's first test proves it before anything else is built on it] |
| B3 | The server resolves the continuation from **stored node outputs** (`node_attempts.output`, artifacted when large; `gateway-activities.ts:279-281`) by `{node, path}`. Only the ref string goes through workflow code and history. | Resolving the change inline would add two more copies of up to 1 MB each (the `harnessPrepare` and `runHarness` inputs). [Certain] |
| B4 | The change is applied as a **local commit** on top of `base_sha`, and `refs/azhi/base` points at `base_sha`. `Checkout.head` stays `base_sha`. | (a) **Read mode**: diff tools compare commits (`refs/azhi/base...HEAD`, `examples/pr-review/harness/mcp/repo-facts.mjs:18-31`); uncommitted files would show "no changes". (b) **Write mode**: the git directory is moved out of the checkout (`workspace.ts:111`), so the agent never sees commits. `collectChange` diffs `c.head` against the staged tree (`:171`), so with `head = base_sha` it reports the **total** change from the real base, and `base_sha` stays a commit that exists on the remote. [Certain] |
| B5 | **Worker feature gating.** Workers advertise `features: ['workspace_continuation']`. `checkWorkers` refuses workers without it for nodes that use `from`, and the run plan shows this. | Workers are selected by runtime name only (`gateway-activities.ts:171-190`). An older worker would silently drop the unknown field and work on the bare base. [Certain] |
| B6 | The engine tells a continued agent what it continues from: one generated prompt line naming the producing step and the changed files. The wording depends on the mode (read: "review/inspect"; write: "build on it; do not re-apply it"). | Adopters' skills may assume a fresh base checkout (ai-sdlc's does). [Certain about the skill text] |
| B7 | v1 supports OpenCode only (both adapters share `cloneWorkspace`). Other executors get the existing `workspace_unsupported` error. | `compile.ts:350`; `harness-claude.ts` and `harness-codex.ts` have no workspace support. [Certain] |
| B8 | A test-node run (`testNode` set, `workflow.ts:104`) passes the resolved change inline, because upstream outputs exist only as fixtures in workflow state. | The only exception to B3. [Certain] |

## Tasks

### B1. UPDATE `src/definition/types.ts`, `src/definition/schema.ts`
- **IMPLEMENT**: `AgentWorkspace.from?: Value`; in the schema, `workspace.from: $ref value`.
- **VALIDATE**: `npm run typecheck`

### B2. UPDATE `src/compiler/compile.ts` (`case 'agent'`, ~336-394)
- **IMPLEMENT**:
  - `from` requires `workspace`.
  - `workspace_from_invalid` for cel, map, literal, a self ref, or an unknown node.
  - Typing through `refTypes`: `compatible` with `WORKSPACE_CHANGE_SCHEMA` passes; an incompatible type is an error; untyped gives the warning `workspace_from_untyped`.
  - `workspace_from_base_ref` error when `base_ref` is also set.
  - Add `'workspace.from'` to `nodeValues` for agents, so it becomes a data edge (ordering and taint).
- **VALIDATE**: `npx vitest run test/compiler.test.ts test/taint.test.ts`

### B3. Server: `src/runtime/workflow.ts`, `src/agents/model-agent.ts` (`harnessPrepare` :462)
- **IMPLEMENT**:
  - `workflow.ts` passes `workspaceFrom: {ref}` (the string) to `harnessPrepare`, or the inline value for test-node runs (B8). It asks `selectWorker` for the `workspace_continuation` feature.
  - `harnessPrepare`:
    1. Load the producer's latest succeeded output for this run (`node_attempts.output`; read the artifact when it is a handle).
    2. Walk the ref path and validate with ajv against `WORKSPACE_CHANGE_SCHEMA` (require `base_sha` and `files`).
    3. Reject a `repo` that differs from the node's resolved `workspace.repo`.
    4. Fail with `invalid_input` if the producer didn't run (for example it was skipped), naming the producer.
  - Make sure an artifact exists for the change with `asArtifact`, which writes the `artifacts` row that `/v1/artifacts/:hash` needs. Return `continuation: {artifact, base_sha, files: n}`.
  - Append the B6 prompt line and a matching manifest item (`continuation`, source `nodes.<id>`, hash).
  - Put `continuation: {artifact, baseSha}` on the worker `workspace` object. No file content.
- **GOTCHA**: `ctx.artifacts.put` alone writes **no** `artifacts` row, and the endpoint would 404 (`gateway.ts:142-146`). Activity inputs stay additive (S2).
- **VALIDATE**: `npm run typecheck && npx vitest run test/loop-subworkflow.test.ts`

### B4. CREATE `src/worker/continuation.ts`; UPDATE `src/worker/workspace.ts`
- **IMPLEMENT**: `WorkspaceSpec.continuation?: {baseSha, change}`. In `cloneWorkspace`:
  1. **Fetch**: with `continuation`, the refspec is `+<baseSha>:refs/azhi/head` (the `REF` regex already accepts a hex SHA). After checkout, assert `HEAD === baseSha`. A mismatch would mean the server returned something else, so fail.
  2. **Validate every path** (agent-written, untrusted). Reject:
     - absolute paths, `..`, backslashes, NUL bytes;
     - any segment equal to `.git` (case-insensitive);
     - Windows-reserved names (`CON`, `NUL`, `AUX`, `COM1`…), `:`, and segments ending in `.` or space;
     - case-insensitive duplicates within the change;
     - an existing parent that is a symlink or not a directory (`lstat`);
     - totals above `CHANGE_LIMITS`.
  3. **Apply**: delete removed files (a missing file is an error), write `utf-8`/`base64` content, and set the mode for `100755` (`git update-index --chmod=+x` so the mode survives on Windows).
  4. **Commit** with the isolated env, the fixed author `azhi <azhi@localhost>`, and hooks off. Skip the commit for `files: []`. Set `refs/azhi/base` to `baseSha`. All of this happens before the write-mode `.git` move (`:111`).
  5. Return `Checkout{head: baseSha, base: baseSha}`.
- **GOTCHA**:
  - The **first test** fetches by SHA from `startFakeGit`. If it fails, enable `uploadpack.allowAnySHA1InWant` in the fake server's env (test-only), and add a doc note that self-hosted git hosts must allow it.
  - With `head = base_sha`, the change that `collectChange` returns covers the previous step's files as well; it must still fit `CHANGE_LIMITS`.
- **VALIDATE**: `npx vitest run test/workspace-continuation.test.ts test/workspace-write.test.ts`

### B5. Worker gating and fetch: `src/worker/capabilities.ts`, `gateway-activities.ts` `checkWorkers`, both OpenCode adapters
- **IMPLEMENT**:
  - `WorkerCapabilities.features?: string[]`; `detectCapabilities` adds `'workspace_continuation'`.
  - `checkWorkers(workspaceId, packageHash, runtime, needs?: string[])` refuses with "worker build does not support workspace continuation; upgrade it".
  - One shared helper fetches `/v1/artifacts/<hash>` with `runApi` (pattern: `script-activity.ts:71-80`) and fills in `spec.continuation.change`. Both `harness-activity.ts` (~137) and `harness-opencode2.ts` (74-83) call it before `cloneWorkspace`.
- **VALIDATE**: `npm run typecheck && npx vitest run test/opencode2.test.ts test/opencode.test.ts test/harness-executors.test.ts`

### B6. Authoring surfaces for B
- `src/plan/run-plan.ts`:
  - A requirement row "worker supports workspace continuation" (native or unsupported, per online worker).
  - A coverage row "starts from the change made by `<node>` at `<base_sha>`, committed locally on the worker".
- `web/src/pages/Editor.tsx` `WorkspaceFields` (`:989`): **Continue from**, listing the steps whose output type-checks as a workspace change. Setting it disables `base_ref`.
- `web/src/graph.ts`: `workspace.from` refs are already found by the `nodes.<id>` text scan; verify this with a test.
- `src/builder/skill.md`: a reference entry for `workspace.from` (OpenCode only), plus a line saying: use `from` on review, verify and fix steps that work on an earlier step's change.
- **VALIDATE**: `npx vitest run test/gate2.test.ts test/editor.test.ts test/builder.test.ts && npm run build:web`

### B7. ADOPT in `examples/ai-sdlc-v2/` (read mode first)
- **IMPLEMENT**: add `workspace.from: {ref: nodes.change_N.output.workspace}` to the lite, standard and full **review and verify** agents (read mode). Keep the diff in their input for now; it becomes optional once `context_budget` with `withhold` can drop it.
- Update the reviewer and verifier skills: "your checkout contains the change; read the changed files there".
- Update `CHANGELOG.md`. Installed copies are three-way merged by `example-merge`, so check the report in `test/example-update.test.ts`.
- **Not in this PR:** fix rounds in write mode. That needs `implement-change/SKILL.md` and `harness/commands/implement.md` rewritten so they stop assuming a fresh base; it is a separate change.
- **VALIDATE**: `npx vitest run test/ai-sdlc-v2.test.ts test/ai-sdlc-v2-finalize.test.ts test/ai-sdlc-e2e.test.ts test/example-update.test.ts`

### B8. Tests and docs
- `test/workspace-continuation.test.ts` (fake git):
  - Fetch by SHA.
  - Applies add, modify, delete, base64 and 755.
  - The local commit makes `git diff refs/azhi/base...HEAD` **non-empty** (the same command `repo-facts.mjs` runs).
  - Write mode: `collectChange` after a further edit reports the total change and `base_sha` equals the remote commit.
  - The base branch moving after the producer ran doesn't matter (B2).
  - Every unsafe path form is rejected, including Windows names, case duplicates and a symlinked parent.
  - Limits.
  - An empty change makes no commit.
  - Each retried attempt starts from a fresh checkout.
- Integration:
  - `harnessPrepare` resolves inline and artifacted outputs.
  - A skipped producer fails loud.
  - A test-node run uses the inline fixture.
  - The **`runHarness` activity input contains no file content** (assert its serialized size).
  - A worker without `features` is refused with a clear reason, and the run plan shows it.
- Taint: a `from` producer that is untrusted taints the consumer; a tainted, ungated write is still `tainted_write_ungated`.
- `docs/context-sharing.md`: the continuation section, covering OpenCode only, read and write semantics, pinning to `base_sha`, self-hosted git needing fetch-by-SHA, the deployment note, and limits.

## Acceptance (PR B)
- [ ] Continuation fetches `base_sha`, applies `files[]` as a local commit, and `refs/azhi/base...HEAD` shows the change.
- [ ] In write mode, the total change keeps the real `base_sha`.
- [ ] Unsafe paths are rejected.
- [ ] No file content enters the workflow-to-worker activity payload.
- [ ] A base branch that moves during the run does not fail the step.
- [ ] Old workers are refused with a clear reason, and the run plan shows it.
- [ ] A continued agent is told what it continues from (wording depends on the mode).
- [ ] ai-sdlc review and verify agents run on a checkout that contains the change.
- [ ] `npm run typecheck`, `npm run test:local` and `npm run build:web` pass.

---

# PR C: Context bundles (`contexts:` / `context:`)

## Decisions

| # | Decision | Evidence / reason |
|---|---|---|
| C1 | **Bundles expand at compile time** into `PlanNode.def.input`. A node using `context` must have an object-literal `input` or none; values inside can be `{ref}`, `{cel}`, or `{map}` per key. The authored definition (and `definitionHash`) is untouched; only the plan node's `def` is a merged copy. | No runtime merge code, and every collision is a compile error. An older interpreter runs the plan correctly because it sees an ordinary `input` (S2). [Certain] |
| C2 | `PlanNode.inputParts?: Array<{key, source}>` (omitted when unused) feeds the per-field manifest and the retrieval guard. | Old builds ignore it; the only loss is manifest granularity. [Certain] |
| C3 | Bundles are allowed on **agent, script and report nodes only**. Not on `subworkflow`: child inputs are validated with ajv against the child's `inputs` schema at run time (`runs.ts:51-55`), so flattened keys fail an `additionalProperties:false` child. | [Certain] |
| C4 | **`context` on a `merge: any` node is a compile error (`context_on_merge`).** | Every ref becomes a dep (`compile.ts:195`, `:205`). A `merge: any` node runs when *any* dep got through (`workflow.ts:524`). A bundle ref to a step that always runs (for example `intake` or `plan`) therefore makes a branch-join node **run when it should skip**: `change_2` (`workflow.yaml:699`) would run with every value null. Merge nodes are also where the explicit `has()` guards belong. Replaces revision 3's `context_ref_on_merge`. [Certain] |
| C5 | **Skip coupling is computed from the real skip rule, and only for new deps.** A bundle-added dep `d` on consumer `c` warns `context_may_skip` only if `d` is *skippable* and `d` is **not already an ancestor** of `c` through its existing (non-bundle) edges. | Revision 3 called "descendant of a route or approval" skippable. In ai-sdlc every step after the `plan` and `mode` merge joins would then warn. An ancestor that is already there adds no new skip condition for a non-merge consumer (`workflow.ts:525`: `deps.some(blocked)`). This also lets `decisions` (from the `design_review` approval) go back into the build bundle, since all three `build*` nodes already depend on it. [Certain about the runtime rule] |
| C6 | `context_taints` (warning): taint is analysed a second time with the bundle-only edges removed. If a node is tainted only because of a bundle, the warning names the bundle key and the untrusted source. | Taint upstream is "any untrusted data dep" (`taint.ts`); `analyseTaint` is pure. [Certain] |
| C7 | Retrieval guard: when `inputParts` is present, `withChunksFor` builds the query from the node's **own** input keys only. | Adding a bundle must not change what an agent with `datasets` retrieves (`gateway-activities.ts:380-393`). [Certain] |

**Skippable** (C5) is computed once over the plan in topological order, mirroring `shouldSkip`:
- `skippable(n)` is true when `n` has a `route`, or `n` is an approval (rejection), or
  - for `merge: any`: **every** dep is skippable;
  - otherwise: **any** dep is skippable.
- Failure-driven skips are ignored (they are run-time conditions, not structure).

## Tasks

### C1. UPDATE `src/definition/types.ts`, `src/definition/schema.ts`
- **IMPLEMENT**:
  - `WorkflowDefinition.contexts?: Record<string, Record<string, Value>>`.
  - `context?: string[]` on `AgentNode`, `ScriptNode` and `ReportNode`.
  - Schema: top-level `contexts`, where names match `id`, each bundle is an object with identifier keys and `$ref value` values, and `minProperties:1`. `context` is an array of `id`, unique, with at least one entry.
- **VALIDATE**: `npm run typecheck && npx vitest run test/compiler.test.ts`

### C2. CREATE `src/compiler/contexts.ts`
- **IMPLEMENT** these pure helpers:
  - `expandContext(node, contexts)` returns `{input, parts}` or diagnostics:
    - `context_input_shape`: the input is not an object literal or absent. The message shows how to turn `{map: "..."}` into per-key `{cel: ...}`.
    - `unknown_context`.
    - `context_collision`: a key repeated across bundles, or between a bundle and the node's own input.
    - `context_on_merge` (C4).
    - Merge order: bundle keys in declaration order, then the node's own keys.
  - `skippableNodes(nodes, deps)` (C5) and `couplingDiagnostics(...)`: `context_may_skip` and `context_taints`.
- **VALIDATE**: `npm run typecheck`

### C3. UPDATE `src/compiler/compile.ts`
- **IMPLEMENT**:
  - **Early step:** build `expanded: Map<id, NodeDef>`. Run **all** existing analysis (`nodeValues`, ref and CEL validation, deps, `dataDeps`, typing) over the expanded nodes. Keep `bundleEdges: Map<id, Set<id>>` for C5 and C6: the deps that appear only through a bundle.
  - Error paths read `input.<key>` and name the bundle ("from context 'brief'").
  - `planNodes.set(... def: expandedNode ...)`. Add `inputParts` only for nodes that use `context` (pattern `compile.ts:482-490`).
  - `unused_context` warning.
  - `ExecutionPlan` is unchanged.
- **GOTCHA**: The authored `def.nodes` must stay untouched; use copies. A cycle error caused by a bundle must name the bundle.
- **VALIDATE**: `npx vitest run test/compiler.test.ts test/taint.test.ts test/context-bundles.test.ts test/context-regression.test.ts`

### C4. UPDATE `src/agents/model-agent.ts`, `src/runtime/workflow.ts`, `src/runtime/gateway-activities.ts`
- **IMPLEMENT**:
  - Pass `inputParts` into `agentBegin` and `harnessPrepare`.
  - With `inputParts`, write one `input` manifest item per top-level key (source `context:<bundle>` or `input`; tokens labelled estimated; withheld keys from PR A noted). Without it, the single item stays byte-identical.
  - C7 retrieval guard in `withChunksFor`.
- **VALIDATE**: `npx vitest run test/agent.test.ts test/datasets.test.ts`

### C5. Editor and graph: `web/src/graph.ts`, `StepDrawer.tsx`, `Editor.tsx`, `WorkflowSettings.tsx`, `stepHelp.ts`
- **IMPLEMENT**:
  - `graphOf` accepts `Pick<Definition, 'nodes' | 'contexts'>` and adds the `nodes.<id>` refs from a node's bundles, so edges, `upstream()` pickers and cycle hints match the compiler.
  - "Gets" (StepDrawer `:95`, `:118`) lists bundle sources as "via <bundle>".
  - Disconnecting an edge that comes from a bundle explains which bundle it comes from.
  - `renameStep` (`Editor.tsx:140-150`) also rewrites refs in `def.contexts`.
  - A **Shared context** picker on agent, script and report drawers, disabled with an explanation on `merge: any` nodes.
  - A **Contexts** section in `WorkflowSettings` (`SectionId` `:37`, `sectionsOf` `:96-100`) that edits bundles and flags unused ones.
- **GOTCHA**: Keep unknown keys and key order (`reorder`). Don't touch the `WorkflowCanvas` head and foot wiring.
- **VALIDATE**: `npm run typecheck && npm run build:web && npx vitest run test/web.test.ts test/step-help.test.ts test/editor.test.ts`

### C6. Builder: `src/builder/skill.md`, `src/builder/builder.ts`, `web/src/pages/Builder.tsx`
- **IMPLEMENT**:
  - **skill.md:**
    - Reference entries for `contexts` and `context`.
    - A section **"Sharing context between steps"** of no more than about 20 lines:
      - Use bundles for fields that several steps need.
      - A node with a bundle takes an object `input`.
      - Keep bundles small, because every entry becomes a dependency of every consumer and an untrusted field taints all of them.
      - Never put a step from a conditional branch into a bundle.
      - Never use `context` on `merge: any`.
      - For notes to the next step, declare a `notes` string with `maxLength` and pass it by ref.
    - "Changing an existing workflow": keep `contexts:` and `context:` when rewriting `workflow.yaml`.
    - Add the new diagnostics to "Rules the compiler enforces".
  - **builder.ts:** coupling warnings and per-step context lines go into the `propose_workflow` notes. No `applyChange` change: `unknown_context` is the backstop when a patch drops `contexts:`.
  - **Builder.tsx `DraftPanel`:** a **Shared context** `draft-facts` entry, shown only when used, built from `p.nodes[].def` and from `contexts` parsed out of `p.files['workflow.yaml']`.
- **VALIDATE**: `npx vitest run test/builder.test.ts test/builder-edit.test.ts && npm run build:web`

### C7. Example and adoption
- CREATE `examples/context-review-revise/`: a non-SDLC research -> draft -> critique -> revise workflow (model agent, scripted provider).
  - One small bundle.
  - `context_budget` with `on_exceed: withhold` on critique.
  - A `notes` field in the draft schema, passed by ref.
- UPDATE `examples/ai-sdlc-v2/`:
  - A `delivery_brief` bundle (`environment`, `ticket`, `requirements`, `design`, `decisions`) on the three `build*` nodes.
  - Per-round `round_N_change` bundles on the review and verify pairs.
  - Convert those `{map}` inputs to object inputs.
  - **Assert the compiled graph (deps, dataDeps, taint paths) is identical before and after.**
  - Update `CHANGELOG.md`.
- **VALIDATE**: `npx vitest run test/example-merge.test.ts test/example-update.test.ts test/ai-sdlc-v2.test.ts test/ai-sdlc-e2e.test.ts`

### C8. Tests and docs
- `test/context-bundles.test.ts`:
  - Merge order and every collision form.
  - A non-object input is rejected with the conversion hint.
  - The authored definition and `definitionHash` are unchanged.
  - `context_on_merge`.
  - Skippable computation:
    - a route member is skippable;
    - a node after a merge join that some path can always reach is **not**;
    - an approval's descendants are.
  - `context_may_skip` fires only for new, non-ancestor, skippable deps.
  - `context_taints` names the bundle key.
  - Bundles on script and report nodes.
  - A bundle referencing `inputs`, `config` or `run`.
  - A bundle causing a cycle names the bundle.
- Integration:
  - A bundle carrying untrusted tool output gives `tainted_write_ungated` (fail closed), exactly like an inline ref.
  - An agent with `datasets` gets the same retrieval query with and without a bundle.
  - A per-field manifest.
  - `builder-edit`: a patch keeps `contexts:`, and a patch that drops it fails with `unknown_context`.
  - `example-merge`: a local edit to one bundle survives an upstream change to another.
- E2E with Playwright via `playwright-core`, as in `test/builder.test.ts`:
  - Editor: add a bundle, use it on two steps, rename the producer, then assert the YAML, the edges and "Gets" (`screenshots/context-editor.png`).
  - Builder draft panel (`screenshots/context-builder.png`).
  - The `unknown_context` error (`screenshots/context-error.png`).
- `docs/context-sharing.md`: the bundles section, covering semantics, coupling with a worked example, the merge-node rule, and "a notes field instead of handoff". Update `docs/workflow-builder.md`, `docs/phase-2.md:28`, and the README link.

## Acceptance (PR C)
- [ ] Bundles expand at compile time, and every collision is a compile error. No interpreter change is needed.
- [ ] `context` on `merge: any` is rejected.
- [ ] Skip coupling follows the real skip rule, with no warnings for deps that are already ancestors.
- [ ] Taint caused only by a bundle is named.
- [ ] Adding a bundle doesn't change an agent's retrieval query.
- [ ] Editor graph, "Gets", rename and pickers account for bundles. The builder teaches and preserves them.
- [ ] ai-sdlc's compiled graph is identical before and after adoption.
- [ ] `npm run typecheck`, `npm run test:local` and `npm run build:web` pass.

---

## CONTEXT REFERENCES

### Files to read before implementing (by PR)

**All PRs**
- `src/definition/types.ts`, `src/definition/schema.ts` (`node()` with `additionalProperties:false`), `src/compiler/plan.ts` (`PlanNode`, `WORKSPACE_CHANGE_SCHEMA` 76-110)

**PR A**
- `src/agents/model-agent.ts`: 96-113 `AgentBeginInput`, 135-139 `item()`, 172-183 `materialise`, 196-249 `agentBegin`, 462-504 `harnessPrepare`
- `src/config/settings.ts` (63), `src/runtime/workflow.ts` (164-212, 214-258, 204 `usage_incomplete`), `src/plan/run-plan.ts`

**PR B**
- `src/worker/workspace.ts`: 16-37 `WorkspaceSpec`/`Checkout`, 68-114 `cloneWorkspace` (refspecs 95, fetch 99, `.git` move 111), 117 `CHANGE_LIMITS`, 168-213 `collectChange`
- `src/worker/harness-activity.ts` (137-147 clone, 404 `collectChange` meta), `src/worker/harness-opencode2.ts` (74-83)
- `src/worker/capabilities.ts`, `src/runtime/gateway-activities.ts` (171-190 `checkWorkers`, 230-290), `src/api/app.ts` (485-491 artifacts endpoint), `src/worker/script-activity.ts` (71-80), `src/runtime/gateway.ts` (142-146 `asArtifact`)
- `src/testing/fake-git.ts`, `test/workspace-write.test.ts`, `examples/pr-review/harness/mcp/repo-facts.mjs` (18-31)

**PR C**
- `src/compiler/compile.ts`: 45 `REF_ROOTS`, 62-100 `nodeValues`, 125-224 ref and CEL deps (195, 205), 226 `topoSort`, 233-300 typing, 438-462 `planNodes.set`, 474-495 taint and plan
- `src/compiler/taint.ts`, `src/compiler/schema-path.ts`, `src/runtime/workflow.ts` 515-526 `shouldSkip`, `src/server/runs.ts` 51-55
- `web/src/graph.ts` 14-31, `web/src/components/StepDrawer.tsx` 14/95/118, `web/src/pages/Editor.tsx` 140-150/200/247, `web/src/components/WorkflowSettings.tsx` 37/96-100, `web/src/pages/Builder.tsx` 43-55/604-665
- `src/builder/skill.md`, `src/builder/builder.ts` (~555-620, ~710-735), `src/api/example-merge.ts` 92-144

### Patterns to follow
- Optional plan fields are spread only when present (`compile.ts:482-490`).
- Diagnostics use `err(code, message, nodeId, path)` / `warn(...)` with snake_case codes that quote the node and value.
- Errors: `AzhiError(ErrorClass.x)` on the server; `ApplicationFailure.create({type, message, nonRetryable:true})` on the worker and in workflow code.
- Run-token capability checks: `app.ts:679-690`. Worker artifact fetch: `script-activity.ts:71-80`.

## VALIDATION COMMANDS (each PR)
- L1: `npm run typecheck`
- L2: the PR's own test files (listed in its tasks), plus `test/context-regression.test.ts`
- L3: `npm run test:local`, `npx vitest run test/gate2.test.ts`
- L4: `npm run demo`. Install the example the PR touches, run it, and inspect the manifest and run events.
- L5: `npm run build:web`; Playwright for PR C
- L6: `git diff --stat` shows no unrelated refactors; `grep -rn "ai-sdlc" src/` shows no new workflow-specific code

---

## NOTES

### What changed in revision 4 and why
1. **Split into three PRs (A cap -> B continuation -> C bundles).** Each one ships alone with its own acceptance criteria. The riskiest and widest piece (bundles) goes last, so it can't block the two that matter most.
2. **New error `context_on_merge` (C4).** Revision 3 missed that bundle deps make a `merge: any` join run when it should skip. The correctness bug was confirmed in `compile.ts:195` and `workflow.ts:524`.
3. **Skip coupling follows `shouldSkip` (C5).** "Descendant of a route or approval" would have warned on almost every ai-sdlc step after the `plan` and `mode` joins. Only new, non-ancestor, skippable deps warn now. As a result `decisions` can go back into the build bundle.
4. **Continuation pins `base_sha` (B2).** The worker fetches the change's own base. Revision 3's "head must equal base_sha" would fail long runs whenever the base branch moved.
5. **Read-mode continuation comes first (B7).** Reviewers and verifiers in ai-sdlc currently inspect a checkout that lacks the change. Fixing that is the highest-value use and needs no skill rewrite. Fix rounds in write mode stay a separate change.
6. **The local commit's purpose is stated precisely (B4).** It serves read-mode diff tooling. In write mode `collectChange` is correct either way, because it diffs from `c.head = base_sha`.
7. **Problem statement corrected.** The largest duplication (the `workspace:` block) is not addressed by bundles, and bundles can't take parameters across rounds. Expected gains from bundles are stated as moderate.
8. **The cap is measured after `materialise` (A2).** Measuring earlier would size artifact handles, not content.

### Deployment constraint
Publish workflows that use `workspace.from` or `context_budget` only after **all server instances and workers** run the matching build:
- A run is pinned to the interpreter build of the server that created it.
- An older server ignores `context_budget`, which fails open on cost.
- An older interpreter drops `workspace.from`. Worker gating catches old workers, not old interpreters.

Bundles are safe on old interpreters because they compile to a plain `input`. [Certain about the pinning; Guessing about how often deployments run mixed builds]

### Follow-ups (not in this plan)
- **Named or default workspaces**, to remove the ~12 repeated `workspace:` blocks: the largest duplication in ai-sdlc.
- Write-mode continuation for ai-sdlc fix rounds (skill and command rewrite).
- A Governance UI setting for the server-wide input cap.
- Dropping the diff from reviewer inputs once continuation and `withhold` are proven in use.

### Pre-existing issues found in passing (not caused by this feature)
- A write-mode harness returns its whole change (file contents up to 1 MB, base64 for binaries, plus a diff of up to 200k characters) as an activity result straight into Temporal history. Near the limits this could exceed Temporal's 2 MB default payload limit. [Likely] PR B does not make this worse (B3). Verify with a large-change test.
- A YAML merge key (`<<: *anchor`) in a workflow is accepted by the schema and silently becomes a literal `<<` input key. [Certain, reproduced]
- ai-sdlc reviewers and verifiers inspect a base checkout without the change (fixed by B7).

### Risks
- PR B path safety: the B4 test matrix is the gate.
- PR B fetch-by-SHA on self-hosted git: the first B4 test proves it locally, and the docs name the server setting.
- PR C taint and coupling: C8's tests are the gate.
- PR C editor work was read structurally, not run.

**Confidence for one-pass success, per PR: A 9/10, B 8/10, C 7.5/10.** Revision 3 put all three together at 7/10. The gain comes from the split, the merge-node fix, the corrected skip rule and base pinning.
