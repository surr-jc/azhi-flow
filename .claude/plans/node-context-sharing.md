# Feature: Generic node-to-node context sharing

The following plan should be complete, but validate documentation and codebase patterns and task sanity before you start implementing. Pay special attention to the naming of existing types and helpers (`Value`, `PlanNode`, `WORKSPACE_CHANGE_SCHEMA`, `AgentBeginInput`, `Checkout`, `WorkerCapabilities`). Branch: `dev`. Conventional commits (`feat:`, `docs:`). Nothing merges, closes or force-pushes.

**Revision 3 (2026-10-29).** Every load-bearing claim was re-verified against the code at `dev` `2d99c8e` (probes run with `tsx`, not inferred). Verification overturned seven design decisions of revision 2; see "What changed in revision 3 and why" at the end. Confidence tags: **[Certain]** = read in code or reproduced; **[Likely]** = strong inference; **[Guessing]** = not verified.

## Feature Description

Nodes already share data through explicit refs (`ref: nodes.X.output.field`, CEL). This feature adds three **opt-in, definition-level** mechanisms any workflow can adopt from YAML upload, "Build with chat", or the visual editor:

1. **Context bundles.** A workflow-level `contexts:` block names a set of upstream values once. Nodes add `context: [name]`. The compiler **expands bundles statically into the node's `input`**, so the runtime is unchanged.
2. **Input cap.** On an agent node, `context_budget` limits the bytes of input that reach the model. The default on exceed is **fail**. Withholding a field is a per-node opt-in that is recorded and shown to people.
3. **Workspace continuation.** `workspace.from: {ref: …}` starts a checkout from an earlier change: the same base commit, with the previous files applied **as a local commit**, so existing diff tooling sees them.

**Dropped from v1: handoff notes.** They add nothing an author can't already get by declaring a `notes` string in `output_schema`. They reserve an engine-owned field name, and they create a channel framed as "instructions for the next step", which suits prompt injection. The builder skill teaches the schema-field pattern instead (Task 15).

Still rejected: shared memory / blackboard, transcript inheritance, LLM "summary" mode, auto-passing all upstream outputs.

## User Story

As a workflow author (YAML, Build with chat, or visual editor)
I want to declare once which upstream values several steps need, cap how much input reaches a model, and let a later agent continue from an earlier agent's code change
So that multi-step workflows stay consistent when edited, cost less, and keep their taint, approval and audit guarantees.

## Problem Statement (verified)

- The same 4–8 line CEL context map is copy-pasted across about 10 agent nodes in `examples/ai-sdlc-v2/workflow.yaml` (`build*`, `lite_fix*`, `lite_review_*`, `lite_verify_*`). [Certain]
- YAML anchors don't solve it. Whole-value aliases work, but **merge keys (`<<`) are not enabled**, and a `<<` key silently becomes a literal input key (reproduced with `parseYaml`). The visual editor also stores the definition as JSON and re-serialises it, so aliases are lost on the first visual edit (`Editor.tsx:200`, `:247`). [Certain]
- Fix rounds pass `previous_diff` as prompt text into a fresh base checkout, and the agent has to re-type the change (`implement-change/SKILL.md:22-24`). [Certain]
- `materialise()` (`model-agent.ts:172`) expands every input artifact in full. Only *output* tokens are budgeted. [Certain]
- The manifest records the whole input as one item (`model-agent.ts:220`). [Certain]
- The builder can't author any of this, and it now edits existing workflows by patch. [Certain]

## Solution Statement and decisions

| # | Decision | Evidence / reason |
|---|---|---|
| D1 | **Bundles expand at compile time** into `PlanNode.def.input`. A node using `context` must have an object-literal `input` or none. Values inside can still be `{ref}`, `{cel}`, or `{map}` per key. The authored definition (and `definitionHash`) is untouched; only the plan node's `def` is a copy with the merged input. | Removes all sandbox/runtime merge code and makes every collision a compile error. An **older interpreter build runs the plan correctly** because it only sees an ordinary `input` (runs are pinned to the interpreter build that created them: `runs.ts:100`, `outbox.ts:102`). [Certain] |
| D2 | `PlanNode.inputParts?: Array<{key, source}>` (omitted when unused) feeds the per-field manifest. | Old builds ignore it, and the only loss is manifest granularity. [Certain] |
| D3 | Bundles are **not** allowed on `subworkflow` in v1 (agent, script, report only). | Child inputs are validated with ajv against the child's `inputs` schema (`runs.ts:51-55`, reached through `prepareChildRun` -> `createRun`). Flattened bundle keys fail an `additionalProperties:false` child at **run** time, and the compiler can't check that because the child resolves at run time. [Certain] |
| D4 | New compile diagnostics for bundle **coupling**: `context_may_skip` (warning), `context_taints` (warning), `context_ref_on_merge` (error). | Every bundle ref becomes a dep **and** a data dep of every consumer. (a) A consumer with a dep that can be skipped is itself skipped unless `merge: any` (`workflow.ts:515-525`). (b) In a `merge: any` consumer, a `{ref}` to a node that did not run is silently **dropped** (`{"j":1}`), and `{cel}` throws `No such key` (both reproduced). (c) Taint upstream is "any untrusted data dep" (`taint.ts`), so one untrusted field taints every consumer. [Certain] |
| D5 | `context_budget: {max_item_bytes?, max_input_bytes?, on_exceed?: fail \| withhold}`. **Bytes, not tokens.** Default `on_exceed: fail` (`budget_exceeded`). | A token cap would be enforced on a `chars/4` guess, which breaks the repository's "never guessed" rule. Silently withholding by default could let a reviewer agent "approve" a diff it never saw. With `withhold`, the run gets a `context_withheld` event and flag, shown on the run page and in approval context. [Certain about mechanism; the reviewer hazard is Likely] |
| D6 | Withheld values are **not** stored again; the manifest records the hash and size only. | They already exist as upstream outputs, the agent has no tool to read artifacts, and storing again would persist data even when `AZHI_STORE_CONTEXT_CONTENT` is off. [Certain] |
| D7 | Retrieval query: when `inputParts` is present, `withChunksFor` builds the query from the node's **own** input keys only. | Today the query is `textOf(whole input)`, built before any budget is applied (`gateway-activities.ts:380-393`). Adding a bundle would otherwise silently change what an agent with `datasets` retrieves, and could send a huge diff to the embedding call. [Certain] |
| D8 | `workspace.from` must be a plain `{ref}` whose type is compatible with `WORKSPACE_CHANGE_SCHEMA` (any node type, for example a selector script). It is **not** limited to write-mode agents. | The content is untrusted wherever it comes from. Safety comes from run-time validation (schema, base SHA, path rules) and the fact that nothing pushes without a gate. A type-based rule is more generic and fixes the ai-sdlc fix-round case (`change_N` scripts). Untyped producer: warning plus run-time validation. [Likely] |
| D9 | The server resolves the continuation from **stored node outputs** (`node_attempts.output`, artifacted when large; `gateway-activities.ts:279-281`) by `{node, path}`. Only the ref string travels through the workflow. | A write-mode harness returns its full change (file contents up to 1 MB) as the activity result straight into workflow history (`harness-activity.ts:406`, `workflow.ts:207`). Resolving it inline would add two more copies (the `harnessPrepare` and `runHarness` inputs). [Certain] |
| D10 | Continuation is applied as a **local commit** in the checkout. `refs/azhi/base` points at `from.base_sha`. `Checkout.head` stays `base_sha` so `collectChange` still reports the cumulative change from the real base. `base_ref` together with `from` is a compile error. | The existing diff tooling diffs commits (`refs/azhi/base...HEAD`, `examples/pr-review/harness/mcp/repo-facts.mjs:18-31`). Uncommitted files would make it report "no changes … do not review". [Certain] |
| D11 | **Worker feature gating.** Workers advertise `features: ['workspace_continuation']` in `WorkerCapabilities`. `checkWorkers` refuses workers without it for nodes that use `from`, and the run plan shows it. | Workers are selected by runtime name only (`gateway-activities.ts:171-190`). An older worker would silently drop the unknown `continuation` field and let the agent work on the bare base. [Certain] |
| D12 | The engine tells a continued agent what it continues from: one generated prompt line listing the producing step and changed files. | Adopters' skills may assume a fresh base checkout (ai-sdlc's does), and the agent would re-apply the change on top of itself. [Certain about the skill text] |
| D13 | v1 executor scope is OpenCode only (both adapters share `cloneWorkspace`). Others get the existing `workspace_unsupported` error. | `compile.ts:350`; `harness-claude.ts`/`harness-codex.ts` have no workspace support. [Certain] |
| D14 | The workspace-wide budget default is a server env setting, default off. | The settings pattern is `settings.ts:63`. A Governance UI setting is a follow-up. |

Corrections to revision 2 claims, for the record:
- "Bundle keys first help prompt caching" was wrong for the Anthropic provider, which caches the **system** block only (`providers.ts:84`). [Certain] It may help OpenAI's automatic prefix caching. [Guessing]
- Budget enforcement in `agentBegin` covering every executor is still true: harnesses take `prep.prompt` from `harnessPrepare` -> `agentBegin` (`workflow.ts:164-194`, `model-agent.ts:462`). [Certain]

## Feature Metadata

**Feature Type**: New Capability (additive, opt-in)
**Estimated Complexity**: High (lower than revision 2: no sandbox runtime merge)
**Primary Systems Affected**: `src/definition`, `src/compiler`, `src/agents`, `src/runtime` (small), `src/worker`, `src/plan`, `src/builder`, `web/`, `examples/`, `docs/`
**Dependencies**: none new.

---

## CONTEXT REFERENCES

### Relevant Codebase Files. YOU MUST READ THESE BEFORE IMPLEMENTING

Definition / compiler
- `src/definition/types.ts` (1-56, 57-92 `AgentNode`/`AgentWorkspace`, 120-165 `WorkflowDefinition`)
- `src/definition/schema.ts` (1-30 `common`/`node()` with `additionalProperties:false`; 66-103 top level and `$defs/value`; 120-170 agent + `workspace`)
- `src/definition/load.ts` (`parseYaml`: `uniqueKeys:true`, no merge keys)
- `src/compiler/compile.ts`: 45 `REF_ROOTS`; 62-100 `nodeValues`; 125-232 dependency/ref/CEL collection, `routeOf`; 233-300 typing (`typeOfRef`, `refTypes`); 336-394 `case 'agent'` incl. 350 `workspace_unsupported`, 358-370 write-mode `refSchema`; 438-462 `planNodes.set`; 474-495 taint and plan.
- `src/compiler/plan.ts` (`PlanNode`, `ExecutionPlan`, `WORKSPACE_CHANGE_SCHEMA` 76-110)
- `src/compiler/taint.ts` (`analyseTaint(nodes, datasets)`, which is pure and can be called twice for D4 `context_taints`)
- `src/compiler/schema-path.ts` (`compatible`, `resolvePath`, `typesOf`)

Runtime / agents
- `src/runtime/workflow.ts`: 148-212 `runHarness` (workspace spec 150-163, `harnessPrepare` 164-177, worker selection 178, run token 179, `runHarness` 180-200, `return r.output` 207); 214-258 `runAgent`; 292-310 `selectWorker`; 515-525 `shouldSkip`.
- `src/runtime/gateway-activities.ts`: 171-190 `checkWorkers`; 230-241 `harnessPrepare`; 243-290 `harnessRecord` (stores output 279-281); 380-393 `textOf` / `withChunksFor`.
- `src/agents/model-agent.ts`: 28-40 `PLATFORM_RULES` (note: says nothing about input being untrusted; profiles carry that); 99-123 `AgentBeginInput`; 138 `item()`; 171-183 `materialise`; 196-249 `agentBegin`; 444-450 `contextSafe`; 462-504 `harnessPrepare` (workspace manifest item ~480).
- `src/config/settings.ts` (63)
- `src/server/runs.ts` (51-55 child input validation; 72-75 test-node needs fixtures for `target.dataDeps`)

Worker
- `src/worker/workspace.ts` (`WorkspaceSpec` 18-33, `Checkout`, `cloneWorkspace` 68-127, `CHANGE_LIMITS`, `WorkspaceChange`, `workGit`, `stageChange`, `collectChange`)
- `src/worker/harness-activity.ts` (104-150; clone 137-147; change returned 406) and `src/worker/harness-opencode2.ts` (74-83)
- `src/worker/capabilities.ts` (7-13 `WorkerCapabilities`, `detectCapabilities`)
- `src/api/app.ts` (485-491 `GET /v1/artifacts/:hash`, workspace-scoped and reachable with a run token since run principals carry `workspaceId`, `auth.ts:12,54`); `src/worker/script-activity.ts:71-80` (a worker reading artifacts with a run token: the pattern to reuse)
- `examples/pr-review/harness/mcp/repo-facts.mjs` (18-31, diff range tooling that D10 must keep working)

Plan / authoring / UI
- `src/plan/run-plan.ts` (120-160 `opencodeSetup`)
- `src/builder/skill.md` (84 reference; `script` 120, `agent` 123, `report` 141; 167 token strategy; 203 compiler rules; 216 controls; 228 suggest; step-1 "Changing an existing workflow" ~22-40)
- `src/builder/builder.ts` (`checkProposal` ~555-620, `nodes` with `def` ~616; `applyChange`; `propose_workflow` handler ~710-735)
- `web/src/graph.ts` (14-31 `graphOf(def: Pick<Definition,'nodes'>)` builds edges from `nodes.<id>` text in each node; **it never sees `contexts`**)
- `web/src/components/StepDrawer.tsx` (14 `INPUT_KEYS`; 95 and 118 "Gets" sources: **will report "nothing from other steps" for bundle-fed steps**)
- `web/src/pages/Editor.tsx` (140-150 `renameStep`; 735 `HARNESS_FIELDS`; 810 `setBudget`; 963 Workspace; 968 Budget; 989 `WorkspaceFields`; 200/247 JSON round-trip)
- `web/src/components/WorkflowSettings.tsx` (37 `SectionId`, 96-100 `sectionsOf`), `web/src/stepHelp.ts`
- `web/src/pages/Builder.tsx` (`Proposal` 43-55, `DraftPanel` 604-665 `draft-facts`)
- `src/api/example-merge.ts` (92-144 `mergeDefinitions`: top-level keys other than `nodes` go through `mergeObject`, so `contexts` is three-way merged as an object [Likely]; confirm with a test)

Tests (patterns)
- `test/compiler.test.ts`, `test/taint.test.ts`, `test/loop-subworkflow.test.ts` (compile + Temporal run), `test/workspace-write.test.ts` (fake git + `cloneWorkspace`), `test/builder.test.ts`, `test/builder-edit.test.ts`, `test/editor.test.ts`, `test/gate2.test.ts` (golden), `test/example-merge.test.ts`, `test/opencode2.test.ts`, `test/harness-executors.test.ts`, `test/pr-review-harness.test.ts` (repo-facts usage).

### New Files to Create
- `src/compiler/contexts.ts`: static bundle expansion, collision checks, `inputParts`, coupling diagnostics.
- `src/agents/context-budget.ts`: pure `applyContextBudget()`.
- `src/worker/continuation.ts`: path validation, apply, local commit (keeps `workspace.ts` readable).
- `docs/context-sharing.md`.
- `examples/context-review-revise/` (non-SDLC example and fixture; code variant compile-only).
- `test/context-bundles.test.ts`, `test/context-budget.test.ts`, `test/workspace-continuation.test.ts`, `test/context-regression.test.ts`.

### Relevant Documentation
- Temporal payload and history limits: https://docs.temporal.io/troubleshooting/blob-size-limit-error (D9). [Likely 2 MB per payload]
- YAML 1.2 merge keys are not part of the core schema: https://eemeli.org/yaml/#options (`merge` option) (background for the problem statement).

### Patterns to Follow
- Optional plan fields are spread only when present (`compile.ts:482-490`). Same for `inputParts`.
- Diagnostics: `err(code, message, nodeId, path)` / `warn(...)` with snake_case codes that quote the node and value.
- Engine-added output typing: `compile.ts:358-370`.
- Run-token capability checks: `app.ts:679-690`. Worker artifact fetch: `script-activity.ts:71-80`.
- Errors: `AzhiError(ErrorClass.x)` on the server; `ApplicationFailure.create({type, message, nonRetryable:true})` on the worker and in workflow code.
- Unknown stays unknown: hard caps use exact bytes; token figures, where shown, are labelled `estimated`.

---

## IMPLEMENTATION PLAN

1. **Foundation:** types and schema.
2. **Compiler:** static bundle expansion, coupling diagnostics, `workspace.from` typing.
3. **Agents/runtime:** byte budget, per-field manifest, retrieval query, continuation lookup.
4. **Worker:** feature flag, safe apply, local commit, prompt note.
5. **Authoring surfaces:** run plan, builder, editor graph/drawer/settings.
6. **Proof:** example, tests, docs, adopter migration.

---

## STEP-BY-STEP TASKS

Before any code change, take the regression baseline: compile every package under `examples/` and `test/fixtures/` with the current compiler and store each plan JSON under `test/golden/context-regression/` (script in the scratchpad, not committed).

### 1. UPDATE `src/definition/types.ts`
- **IMPLEMENT**: `WorkflowDefinition.contexts?: Record<string, Record<string, Value>>`. `context?: string[]` on `AgentNode`, `ScriptNode`, `ReportNode` (**not** `SubworkflowNode`, D3). `AgentNode.context_budget?: { max_item_bytes?: number; max_input_bytes?: number; on_exceed?: 'fail' | 'withhold' }`. `AgentWorkspace.from?: Value`.
- **VALIDATE**: `npm run typecheck`

### 2. UPDATE `src/definition/schema.ts`
- **IMPLEMENT**: top-level `contexts` (object; names match `id`; each bundle an object with identifier keys, values `$ref value`, `minProperties:1`). `context` (array of `id`, unique, min 1) on script/agent/report. Agent `context_budget` (`max_item_bytes` int >= 256, `max_input_bytes` int >= 1024, `on_exceed` enum, `minProperties:1`, no extra keys). `workspace.from: $ref value`.
- **GOTCHA**: `node()` sets `additionalProperties:false`, so list each key per node type. Older servers reject these keys (fail closed). That is desired.
- **VALIDATE**: `npx vitest run test/compiler.test.ts`

### 3. CREATE `src/compiler/contexts.ts`
- **IMPLEMENT** pure helpers:
  - `expandContext(node, contexts)`. Returns `{input, parts}` or diagnostics:
    - `context_input_shape` when `input` is anything but an object literal or absent. The message shows how to convert a `{map: "..."}` input to per-key `{cel: ...}` values.
    - `unknown_context` for an unknown bundle name.
    - `context_collision` for a duplicate key across bundles or between a bundle and the node's own `input`.
    - Merge order: bundle keys in declaration order, then the node's own keys.
  - `couplingDiagnostics(...)` (Task 4).
- **VALIDATE**: `npm run typecheck`

### 4. UPDATE `src/compiler/compile.ts`: expansion, typing, coupling
- **IMPLEMENT**:
  - **Early step:** build `expanded: Map<id, NodeDef>` from `def.nodes` with the merged `input` for nodes that use `context`. Run **all** existing analysis (`nodeValues`, ref/CEL validation, deps, `dataDeps`, typing) over the expanded nodes. Bundle refs then become ordinary refs: type-checked, ordered, and visible to taint with no other change.
  - Error paths should read like `input.<key>` and name the bundle in the message ("from context 'brief'"), so authors can find the source.
  - `planNodes.set(... def: expandedNode ...)`. Add `inputParts` only for nodes that use `context`.
  - Warning `unused_context` for a bundle nothing references.
  - **Coupling diagnostics (D4):**
    - `context_may_skip` (warning): a bundle adds a dependency on a node that can be skipped (it is in a condition route or downstream of one, or downstream of an approval), and the consumer did not already depend on that node and is not `merge: any`. The message names the bundle key and says the step will be skipped when that branch does not run.
    - `context_ref_on_merge` (error): a `merge: any` consumer's bundle value is a `{ref}` or unguarded `{cel}` to a node that can be skipped. A ref would be silently dropped and CEL would throw. Require a guarded `{cel: "has(nodes.x) ? … : null"}`.
    - `context_taints` (warning): run `analyseTaint` once more with bundle-only edges removed. If a node is tainted or untrusted only because of a bundle, name the bundle key and the untrusted source.
  - Keep `ExecutionPlan` unchanged (no `contexts` field needed after expansion).
- **GOTCHA**: The node's authored `def` (in `def.nodes`) must stay untouched, so `definitionHash` and signing are unaffected. Use copies. "Can be skipped" = a member of `routeOf`, or a descendant of a route member or of an approval node. Compute it once from the existing `deps`.
- **VALIDATE**: `npx vitest run test/compiler.test.ts test/taint.test.ts test/context-bundles.test.ts`

### 5. UPDATE `src/compiler/compile.ts`: `workspace.from` (D8, D10, D13)
- **IMPLEMENT** in `case 'agent'`:
  - `from` requires `workspace`. It must be a plain `{ref: 'nodes.<id>.output…'}` (`workspace_from_invalid` for cel/map/literal, a self ref, or an unknown node).
  - Typing: the ref's schema (`refTypes`) must be `compatible` with `WORKSPACE_CHANGE_SCHEMA`. An untyped producer gives a warning `workspace_from_untyped` (checked at run time). Incompatible gives an error.
  - `base_ref` with `from` is an error (`workspace_from_base_ref`).
  - Add `'workspace.from'` to `nodeValues` for agents so it becomes a data edge (ordering and taint).
- **VALIDATE**: `npx vitest run test/compiler.test.ts`

### 6. UPDATE `src/runtime/workflow.ts` (small)
- **IMPLEMENT**:
  - Pass `inputParts: node.inputParts` and `contextBudget: def.context_budget` into `agentBegin` (`:224`) and `harnessPrepare` (`:164`).
  - For `workspace.from` pass `workspaceFrom: { ref: <the ref string> }` to `harnessPrepare`, **not** the resolved value (D9). The exception is a test-node run (`testNode` set, `workflow.ts:104`), where upstream outputs exist only as fixtures in workflow state. In that case pass the resolved value inline.
  - Add `continuation` (from the `harnessPrepare` result) to the worker `workspace` object. Put the artifact hash in the run token only if a new claim is needed. Prefer the existing `/v1/artifacts/:hash` (workspace-scoped, readable with a run token, already used by script workers).
  - Request a worker with the continuation feature (Task 11).
- **GOTCHA**: Runs are pinned to their interpreter build. Changes here only affect new runs. Keep activity inputs additive.
- **VALIDATE**: `npm run typecheck && npx vitest run test/loop-subworkflow.test.ts`

### 7. CREATE `src/agents/context-budget.ts` + UPDATE `src/agents/model-agent.ts`
- **IMPLEMENT** `applyContextBudget(input, {maxItemBytes?, maxInputBytes?, onExceed})`. It returns `{input, withheld: [{key, bytes, hash}]}` or throws `AzhiError(ErrorClass.budgetExceeded, …)` naming the node, key and numbers.
  - `fail` (the default) throws on any breach.
  - `withhold` replaces oversized top-level keys (largest first, ties by key order) with `{note: "withheld: <n> bytes, above this step's context_budget; you cannot read it. Say so if it matters to your result.", bytes, sha256}`, and throws if the input is still over `maxInputBytes`.
  - It never stores content (D6).
- In `agentBegin`: `materialise`, then apply the budget (node limits override server defaults, Task 8).
  - With `inputParts`: one `input` manifest item per top-level key (source `context:<bundle>` or `input`, tokens labelled estimated, withheld noted). Without it: today's single item, byte-identical.
  - When anything is withheld, return it in the activity result so the workflow records a `context_withheld` run event and flag (mirror `usage_incomplete`, `workflow.ts:204`).
- **GOTCHA**: The harness prompt is the transcript's first user message (`harnessPrepare`), so the capped text is what every executor sees.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts test/agent.test.ts`

### 8. UPDATE `src/config/settings.ts` and `src/runtime/gateway-activities.ts` (retrieval)
- **IMPLEMENT**:
  - `contextBudget: {maxItemBytes, maxInputBytes}` from `AZHI_CONTEXT_MAX_ITEM_BYTES` / `AZHI_CONTEXT_MAX_INPUT_BYTES`. Both unset by default. Invalid values are ignored with a startup warning. `on_exceed` for the server default is always `fail`.
  - In `withChunksFor` (`:388-393`), when `input.inputParts` is present, build the query from the keys whose source is `input` (D7). Otherwise behave as today.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts test/datasets.test.ts`

### 9. UPDATE `harnessPrepare` (`model-agent.ts:462`): continuation lookup (D9, D12)
- **IMPLEMENT**:
  - Given `workspaceFrom.ref`, load the producing node's latest succeeded output for this run (`node_attempts.output`; if it is an artifact handle, read it from the store), walk the ref path, and validate the result with ajv against `WORKSPACE_CHANGE_SCHEMA` (require `base_sha`, `files`). Reject a `repo` mismatch with the node's resolved `workspace.repo`. Fail loud with `invalid_input` if nothing is found (for example the producer was skipped).
  - Make sure an artifact exists for the change (`asArtifact`, which also writes the `artifacts` row that `/v1/artifacts/:hash` requires) and return `continuation: {artifact, base_sha, files: n}`.
  - Append the generated note to the prompt: "Your checkout already contains the change made by step `<id>` (<n> files: …). Build on it; do not re-apply it." Add the matching manifest item.
- **GOTCHA**: `ctx.artifacts.put` alone writes **no** `artifacts` row, and the endpoint would 404. Use `asArtifact` (`gateway.ts:142-146`).
- **VALIDATE**: `npm run typecheck`

### 10. CREATE `src/worker/continuation.ts` + UPDATE `src/worker/workspace.ts`
- **IMPLEMENT**: `WorkspaceSpec.continuation?: {baseSha, change}`. In `cloneWorkspace`, after `head` is read (~101) and before the write-mode `.git` move:
  1. If `head !== baseSha`, throw `invalid_input` (non-retryable). Name both SHAs and suggest `ref: {ref: nodes.<id>.output.workspace.base_sha}`.
  2. Validate every path (untrusted, written by an agent). Reject:
     - absolute paths, `..`, backslashes, NUL bytes;
     - any segment equal to `.git` (case-insensitive);
     - Windows-reserved names (`CON`, `NUL`, `AUX`, `COM1`…), `:`, and segments ending in `.` or space;
     - case-insensitive duplicates within the change;
     - any existing parent that is a symlink (`lstat`);
     - totals above `CHANGE_LIMITS`.
  3. Apply: delete removed files (a missing file is an error), write `utf-8`/`base64` content, and set the mode for `100755`.
  4. Commit locally (isolated env, fixed author `azhi <azhi@localhost>`, hooks off as configured) and set `refs/azhi/base` to `baseSha`. The returned `Checkout.head` stays `baseSha` (D10), so `collectChange` reports the cumulative change and `base_sha` stays a commit that exists on the remote.
- **GOTCHA**: On Windows the exec bit can't be represented, and a re-collected change could drop `100755`. Carry the mode from `change.files` in `collectChange` when the file is unchanged since continuation, or document the limit. [Likely] The cumulative change must still respect `CHANGE_LIMITS`.
- **VALIDATE**: `npx vitest run test/workspace-continuation.test.ts test/workspace-write.test.ts`

### 11. UPDATE `src/worker/capabilities.ts`, `gateway-activities.ts` `checkWorkers`, both OpenCode adapters (D11)
- **IMPLEMENT**:
  - `WorkerCapabilities.features?: string[]`; `detectCapabilities` adds `'workspace_continuation'`.
  - `checkWorkers(workspaceId, packageHash, runtime, needs?: string[])` refuses workers lacking a needed feature, with the reason "worker build does not support workspace continuation; upgrade it".
  - Both adapters fetch `/v1/artifacts/<hash>` with `runApi` (pattern `script-activity.ts:71-80`) and pass `spec.continuation` to `cloneWorkspace`.
  - Put the fetch in one helper shared by both adapters.
- **VALIDATE**: `npm run typecheck && npx vitest run test/opencode2.test.ts test/opencode.test.ts test/harness-executors.test.ts`

### 12. UPDATE `src/plan/run-plan.ts`
- **IMPLEMENT**:
  - Continuation: a requirement row "worker supports workspace continuation" (native/unsupported per online worker), and a coverage row "starts from the change made by `<node>`, committed locally on the worker; base commit must match".
  - Budget: a row with the limits and the `on_exceed` mode.
  - Per node: the bundles it uses and the coupling warnings.
- **VALIDATE**: `npx vitest run test/gate2.test.ts` (golden unchanged)

### 13. UPDATE `web/src/graph.ts` and `web/src/components/StepDrawer.tsx`
- **IMPLEMENT**:
  - `graphOf` accepts `Pick<Definition, 'nodes' | 'contexts'>` and adds `nodes.<id>` refs found in the bundles a node lists, so editor edges, the `upstream()` pickers and cycle hints match the compiler.
  - In StepDrawer, "Gets" includes bundle sources, labelled "via <bundle>".
  - The editor's disconnect action on a bundle-derived edge explains that the edge comes from bundle `<name>` instead of silently doing nothing.
- **VALIDATE**: `npm run typecheck && npx vitest run test/web.test.ts test/step-help.test.ts`

### 14. UPDATE `web/src/pages/Editor.tsx`, `WorkflowSettings.tsx`, `stepHelp.ts`
- **IMPLEMENT**:
  - `renameStep` also swaps refs in `def.contexts`; omit the key when it is undefined.
  - Agent/script/report drawers get a **Shared context** picker.
  - Agents get **Input cap** (bytes, `on_exceed` select defaulting to fail).
  - `WorkspaceFields` gets **Continue from** (lists steps whose output type-checks as a workspace change; it disables `base_ref`).
  - New **Contexts** section in `WorkflowSettings` (edit bundles; flag unused ones).
  - Help strings.
- **GOTCHA**: Preserve unknown keys and key order (`reorder`). Do not touch the `WorkflowCanvas` head/foot wiring.
- **VALIDATE**: `npm run typecheck && npm run build:web && npx vitest run test/editor.test.ts`

### 15. UPDATE `src/builder/skill.md`
- **IMPLEMENT**:
  - Reference entries for `contexts`, `context` (agent/script/report only), `context_budget`, and `workspace` incl. `from` (OpenCode only).
  - A short section **"Sharing context between steps"** after "Policies and controls to offer":
    - Bundles for fields that several steps need.
    - Bundles take an object `input` (per-key `{cel}`, not one `{map}`).
    - Keep bundles small: everything in a bundle becomes a dependency of every step that uses it, and an untrusted field taints all of them.
    - Never put a step from a conditional branch into a shared bundle.
    - `workspace.from` for revise/fix steps.
    - `context_budget` for inputs that can be large (fail by default).
    - For notes to the next step, declare a `notes` string with `maxLength` in the producer's `output_schema` and pass it by ref.
  - In "Changing an existing workflow", tell the model to keep `contexts:` and `context:` lists when it rewrites `workflow.yaml`.
  - Add the new diagnostics to "Rules the compiler enforces".
  - Keep the new section under about 25 lines (the skill is sent on every turn).
- **VALIDATE**: `npx vitest run test/builder.test.ts test/builder-edit.test.ts`

### 16. UPDATE `src/builder/builder.ts`
- **IMPLEMENT**:
  - After a successful compile, include coupling warnings and per-step context lines in the notes returned to the model (`propose_workflow` handler).
  - No change to `applyChange`. The compiler's `unknown_context` error is the backstop when a patch drops `contexts:`.
- **VALIDATE**: `npx vitest run test/builder.test.ts test/builder-edit.test.ts`

### 17. UPDATE `web/src/pages/Builder.tsx`
- **IMPLEMENT**: in `DraftPanel`, a **Shared context** `draft-facts` entry (shown only when used) and per-step lines, built from `p.nodes[].def` (the expanded plan def) and from `contexts` parsed out of `p.files['workflow.yaml']` with `yaml`. No API change.
- **VALIDATE**: `npm run typecheck && npm run build:web`

### 18. CREATE `examples/context-review-revise/`
- **IMPLEMENT**:
  - A non-SDLC research -> draft -> critique -> revise workflow (model-agent, runnable with the scripted provider).
  - One small bundle; `context_budget` with `on_exceed: withhold` on the critique step.
  - A `notes` field in the draft schema, passed by ref (the documented replacement for handoff).
  - A compile-only code variant that uses `workspace.from`.
- **VALIDATE**: `npx vitest run test/example-merge.test.ts test/example-update.test.ts`

### 19. UPDATE `examples/ai-sdlc-v2/` (last, as an adopter)
- **IMPLEMENT**:
  - Convert the repeated `{map}` inputs to object inputs and introduce `contexts: delivery_brief`.
  - **Bundles only in v1.** Continuation for the fix round is now technically possible (D8 accepts `change_N`), but it requires rewriting `implement-change/SKILL.md` and `harness/commands/implement.md`, which assume a fresh base. Do that as a separate change.
  - Expect `context_may_skip` warnings for anything route-dependent. Keep route-dependent values (`decisions` comes from `design_review`) out of the shared bundle.
- **GOTCHA**: the compiled graph (deps, dataDeps, taint paths) must be identical before and after. Assert it. Update `CHANGELOG.md`. Installed copies are three-way merged by `example-merge`, so check the update report in `test/example-update.test.ts`.
- **VALIDATE**: `npx vitest run test/ai-sdlc-v2.test.ts test/ai-sdlc-v2-finalize.test.ts test/ai-sdlc-e2e.test.ts test/example-update.test.ts`

### 20. Tests and docs
- **CREATE/UPDATE** the tests listed in the Testing Strategy.
- **CREATE** `docs/context-sharing.md` (style: `docs/loops-and-subworkflows.md`). Include:
  - exact semantics and error codes;
  - the coupling warnings explained with an example;
  - the input-cap modes and the reviewer hazard;
  - executor and worker support;
  - the deployment note;
  - the "notes field instead of handoff" pattern;
  - the rejected list.
- **UPDATE** `docs/workflow-builder.md` (section before "## API"), `docs/phase-2.md:28`, README link.
- **VALIDATE**: `npm run test:local`

---

## TESTING STRATEGY

### Unit
- `expandContext`: merge order; every collision form; non-object input rejected with a conversion hint; authored definition unchanged; `definitionHash` unchanged by expansion.
- Coupling: `context_may_skip` fires for a route member, a descendant of a route, and a descendant of an approval, but not when the consumer already depended on the node or is `merge: any`. `context_ref_on_merge` fires for `{ref}` and unguarded `{cel}`, not for `has()`-guarded CEL. `context_taints` names the bundle key.
- `applyContextBudget`: `fail` default; `withhold` largest-first with a stable tie-break; still over -> error; the input object is returned unchanged when no limits are set; no storage calls.
- Continuation (fake git):
  - applies add/modify/delete/base64/755;
  - local commit; `refs/azhi/base...HEAD` is **non-empty** (run the same `git diff` that `repo-facts.mjs` runs);
  - `collectChange` after a further edit reports the cumulative change from the original base, and `base_sha` equals the remote commit;
  - SHA mismatch fails naming both SHAs;
  - every unsafe path form is rejected (incl. Windows names, case duplicates, symlinked parent);
  - limits;
  - each retried attempt starts from a fresh checkout.

### Integration
- Taint: a bundle carrying an untrusted tool output taints consumers and makes an ungated write a `tainted_write_ungated` error (fail closed), exactly like an inline ref.
- Regression: every example and fixture compiles to the baseline plan JSON byte-for-byte; `test/gate2.test.ts` golden unchanged.
- Temporal run (model agent, scripted provider) of `context-review-revise`:
  - per-field manifest items;
  - a withheld field shows a `context_withheld` event and flag;
  - `fail` mode fails with `budget_exceeded`;
  - an agent with `datasets` gets the same retrieval query with and without a bundle.
- Old-worker gating: a worker without `features` is refused for a `from` node with a clear reason; the run plan shows it.
- Continuation lookup:
  - `harnessPrepare` resolves from `node_attempts` (inline and artifacted outputs);
  - the producer being skipped fails loud;
  - a test-node run uses the inline fixture;
  - the `runHarness` activity input contains no file content (assert its serialized size).
- Builder: the skill contains the section; a scripted proposal with a bundle and `from` compiles and its notes list coupling warnings. `builder-edit`: a patch preserves `contexts:`, and a patch dropping it fails with `unknown_context`.
- Editor/UI: `graphOf` draws bundle edges; "Gets" lists bundle sources; rename rewrites bundle refs.
- `example-merge`: a local edit to a bundle survives an upstream change to another bundle.

### Edge Cases
- `input` absent (bundle only); a bundle used by script and report nodes; a bundle that references `inputs`/`config`/`run`.
- A bundle that references a node downstream of a consumer (the cycle error must name the bundle).
- Bundle values that are artifact handles above 256 KB (`$artifact_path` deferred refs still materialise).
- `max_item_bytes` smaller than every field; an empty change (`files: []`, which makes a no-op commit, so skip the commit); `diff_truncated: true` (continuation still exact, because it uses `files`).

### E2E (Playwright via `playwright-core`, as in `test/builder.test.ts`)
- Editor: add a bundle, use it on two steps, rename the producer. Assert the YAML, the drawn edges and "Gets". Screenshot `screenshots/context-editor.png`.
- Builder: a scripted draft with a bundle. The draft panel shows "Shared context". Screenshot `screenshots/context-builder.png`.
- Error: a hand-edited unknown bundle shows `unknown_context`. Screenshot `screenshots/context-error.png`.

---

## VALIDATION COMMANDS
- L1: `npm run typecheck`
- L2: `npx vitest run test/compiler.test.ts test/taint.test.ts test/context-bundles.test.ts test/context-budget.test.ts test/workspace-write.test.ts test/workspace-continuation.test.ts`
- L3: `npm run test:local` and `npx vitest run test/context-regression.test.ts test/gate2.test.ts test/builder.test.ts test/builder-edit.test.ts test/editor.test.ts test/example-update.test.ts`
- L4: `npm run demo`; install `examples/context-review-revise` locally, run it, inspect the manifest and run events.
- L5: `npm run build:web` and the Playwright tests above.
- L6: `git diff --stat` shows no unrelated refactors; `grep -rn "ai-sdlc" src/` shows no new workflow-specific code.

---

## ACCEPTANCE CRITERIA

- [ ] All mechanisms are declared in `src/definition/schema.ts`. None needs a profile, skill or example file to work.
- [ ] Workflows not using them compile to byte-identical plans (regression baseline + golden).
- [ ] Bundles expand at compile time. The runtime interpreter needs no change to run them, and every collision is a compile error.
- [ ] Coupling is visible: skip coupling, merge-node refs and bundle-only taint each produce the specified diagnostic.
- [ ] The input cap uses exact bytes, fails by default, records and shows a withheld field, and never stores content again. It covers the model agent and all harness executors.
- [ ] Adding a bundle does not change an agent's retrieval query.
- [ ] Continuation applies `files[]` as a local commit; `refs/azhi/base...HEAD` shows the change; the cumulative change keeps the real `base_sha`; unsafe paths are rejected; SHA mismatch fails loud; no file content enters the workflow-to-worker activity payload.
- [ ] Workers without the continuation feature are refused with a clear reason, and the run plan shows it.
- [ ] A continued agent is told it continues from step `<id>`.
- [ ] Builder: the skill teaches the mechanisms, coupling rules and the notes-field pattern; patch edits keep `contexts:`.
- [ ] Editor: the graph, "Gets", rename and pickers all account for bundles.
- [ ] Docs state the limits honestly (OpenCode-only continuation, withheld means unreadable, deployment note, coupling).
- [ ] `npm run typecheck`, `npm run test:local`, `npm run build:web` pass; conventional commits on `dev`.

---

## NOTES

### What changed in revision 3 and why
1. **Bundles move from run-time merge to compile-time expansion.** Old interpreter builds then run them correctly, collisions become compile-only, and the sandbox runtime needs no change. The price is that inputs using `context` must be object-shaped (per-key CEL).
2. **Coupling hazards were found and verified.** Skip coupling (`shouldSkip`), silent key drop on merge nodes (reproduced), CEL `No such key` (reproduced), and taint widening. Each now has a diagnostic.
3. **Subworkflow is excluded from bundles.** Child input validation would reject flattened keys at run time.
4. **The budget uses bytes and fails by default.** A token cap would rest on a guess. Silent withholding could let a reviewer approve unseen code.
5. **The retrieval query is protected.** The query is built from the whole input before any budget.
6. **Continuation design.** It is committed locally (existing diff tools diff commits), resolved server-side from stored outputs (avoids duplicating ~1 MB payloads), gated on a worker feature flag (stale workers would silently ignore it), the agent is told it is continuing, the producer is typed rather than limited to write-mode agents, and `asArtifact` is required (raw `put` makes the artifact endpoint 404).
7. **Handoff is dropped.** It is equivalent to a schema field, reserves a name, and invites injection. `PLATFORM_RULES` has no "input is data" rule, so the profile is the only defence.
8. **The prompt-caching claim is withdrawn.** The Anthropic provider caches only the system block.

### Deployment constraint
Publish workflows that use `workspace.from` or `context_budget` only after **all server instances and workers** run this build:
- A run is pinned to the interpreter build of the server that created it.
- An older server ignores `context_budget` (fails open on cost).
- An older interpreter would drop `workspace.from`. Worker gating catches old workers, not old interpreters.

Bundles are safe on old interpreters because they compile to a plain `input`. [Certain about the pinning; Guessing about how often your deployments run mixed builds.]

### Pre-existing issues found in passing (not caused by this feature)
- A write-mode harness returns its whole change (file contents up to 1 MB, base64 for binaries, plus a 200k-char diff) as an activity result straight into Temporal history. Near the limits this could exceed Temporal's payload limit (2 MB by default). [Likely] Verify with a large-change test before relying on it.
- A YAML merge key (`<<: *anchor`) in a workflow is accepted by the schema and becomes a literal `<<` input key, silently. [Certain, reproduced]

### Risks
- Taint/coupling remains the main risk; Task 4's diagnostics and the taint tests are the gate.
- Continuation path safety; Task 10's test matrix is the gate.
- Editor work was read structurally, not run.

**Confidence for one-pass success: 7/10.** Lower runtime risk than revision 2 (no sandbox merge), offset by the added worker gating, local-commit and diagnostic work.
