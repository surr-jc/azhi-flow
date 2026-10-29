# Feature: Generic node-to-node context sharing

The following plan should be complete, but validate documentation and codebase patterns and task sanity before you start implementing. Pay special attention to the naming of existing types and helpers (`Value`, `ValueScope`, `PlanNode`, `WORKSPACE_CHANGE_SCHEMA`, `AgentBeginInput`, `Checkout`). Import from the right files. Branch: `dev`. Conventional commits (`feat:`, `docs:`). Nothing merges, closes or force-pushes.

**Revision 2 (2026-10-29): re-validated against `origin/dev` at `2d99c8e`.** Since the first draft, `dev` gained the chat-first Build-with-chat redesign, builder edits of existing workflows by patch (`new_version_of` + `remove`), MCP-server proposals, and canvas/page restyling (61 files). The compiler, definition, runtime, agents, API, plan, config and security modules are unchanged (only a 2-line git stall setting in `cloneWorkspace`), so Tasks 1-14 stand with shifted line numbers. Tasks 15-17 and 25 were rewritten, a builder-edit preservation requirement and test were added, and the line references below are current as of `2d99c8e`. Line numbers drift; match by symbol name if they do not line up.

## Feature Description

Nodes already share data through explicit refs (`ref: nodes.X.output.field`, CEL maps). Four gaps make sharing context clumsy, costly or lossy. This feature closes them with four **opt-in, definition-level** mechanisms that any workflow can adopt, from YAML upload, the "Build with chat" builder, or the visual editor:

1. **Context bundles.** A workflow-level `contexts:` block names a set of upstream fields once. A node adds `context: [name]` and receives those fields in its input. Bundles are declared once, and the manifest records one item per field.
2. **Context budget.** An agent node's `context_budget` caps how much of its input reaches the model. An oversized field is withheld and replaced by `{note, artifact, shape}`. Default OFF.
3. **Workspace continuation.** `workspace.from: {ref: nodes.X.output.workspace}` starts a node's checkout from the change a previous write-mode agent made: same base commit, previous files applied. The diff no longer travels through the prompt, and review findings point at real files.
4. **Handoff notes.** `handoff: {max_chars}` on an agent node adds an engine-owned optional `handoff` string to its output, for notes to the next agent. Taint follows the producer like any other output field.

Explicitly **not** built (decided in brainstorming): shared memory / blackboard, transcript inheritance, LLM "summary" mode, auto-passing all upstream outputs. Each would create hidden data edges, bypass taint analysis, or break Temporal replay determinism.

## User Story

As a workflow author (writing YAML, using "Build with chat", or using the visual editor)
I want to declare once which upstream results a step needs, cap how much of them the model sees, hand a previous agent's code change to the next agent as a checkout, and pass short notes between agents
So that multi-step workflows cost fewer tokens, stay consistent when edited, and keep the taint, approval and ledger guarantees without any copy-pasted CEL.

## Problem Statement

Verified in the code (file:line):

- `examples/ai-sdlc-v2/workflow.yaml` repeats the same 4-8 line CEL context map in `build`, `build_untested`, `build_static`, `lite_fix`, `lite_fix_untested`, `lite_fix_static`, `lite_review_1/2` and `lite_verify_1/2`. One missed edit gives one variant different context, with no diagnostic.
- Fix rounds pass `previous_diff` as JSON in the prompt into a **fresh base checkout** (`workflow.yaml` `lite_fix` input; `implement-change/SKILL.md:22-24` tells the agent to "re-apply the change"). The agent has edit tools only (no shell), so it retypes the diff.
- `materialise()` (`src/agents/model-agent.ts:172`) expands every artifact in an agent's input in full. Only output tokens are budgeted (`AgentBeginInput`, `model-agent.ts:99-123`); nothing caps input size.
- The manifest records the whole input as one item with a comma-joined source (`model-agent.ts:220`), so you cannot see which field cost what, or which carried untrusted text.
- Only `output_schema` fields cross nodes. There is no sanctioned slot for "notes to the next agent".
- The chat builder cannot author any of this: the agent-node reference in `src/builder/skill.md` (the `- \`agent\`` bullet, ~line 123) never mentions `workspace`, and nothing teaches bundles or budgets. It can also now **edit** an existing workflow by sending only changed files, so a rewrite of `workflow.yaml` can silently drop a `contexts:` block it was never taught about.

## Solution Statement

All four mechanisms are declared in the **definition schema** (`src/definition/schema.ts`), never in profiles or skills, and compiled into the existing data-edge machinery so taint, type-checking and the run plan work unchanged.

Key design decisions (with the corrections to the brainstorm that reading the code forced):

| # | Decision | Why |
|---|---|---|
| D1 | Bundles are **flattened** into the node input (`{...bundleKeys, ...inputKeys}`), bundle keys first. | Matches how `input.requirements` etc. are read by existing skills today, and puts stable content first for prompt caching. Collisions are a compile error when statically detectable (literal-object `input`, two bundles) and a deterministic run-time `contract_violation` otherwise (`input` as `{map: "<CEL>"}` / `{ref}`). Never silently overwritten. |
| D2 | The plan stores bundle definitions once in `ExecutionPlan.contexts` (omitted when unused); node `def` keeps `context: [names]`. | Existing workflows compile to byte-identical plans (regression test). The runtime resolves bundles from the plan inside the workflow sandbox (pure, deterministic). |
| D3 | `context_budget` is enforced in `agentBegin` (`model-agent.ts:196`). | **Correction:** `harnessPrepare` (`model-agent.ts:462`) calls `agentBegin`, so this single point covers the model agent **and every harness executor**. (The brainstorm wrongly said harnesses build their own prompts.) |
| D4 | Withheld input fields are stored in the artifact store and referenced by hash, but the agent has **no tool to read artifacts** (only `gateway-activities.ts` references them). | State this honestly in docs: a capped field is withheld, not deferred. Pair with `workspace.from` so agents read files instead of a diff. |
| D5 | Continuation applies the previous change from `workspace.files[]` (complete content, up to 1 MB), **not** by `git apply` of `diff`. | **Correction:** `diff` can be truncated at 200k chars (`CHANGE_LIMITS.diffChars`, `workspace.ts`); `files` is complete. |
| D6 | The change travels to the worker via the **artifact store**, not the Temporal payload. | `files` can be ~1 MB; Temporal's default blob limit is 2 MB. Mirror the `creds` run-token pattern (`src/api/app.ts:679`): add an `arts` claim and `GET /v1/gateway/artifacts/:hash`. |
| D7 | v1 scope: **OpenCode only** (both adapters). | `compile.ts:350` already restricts `workspace` to `executor: opencode`; `harness-claude.ts`/`harness-codex.ts` have no workspace support. Both OpenCode adapters share `cloneWorkspace` (`harness-activity.ts:145`, `harness-opencode2.ts:82`), so one change point covers them. Other executors get a compile error naming the executor, which `workspace_unsupported` already does. |
| D8 | The workspace-wide `context_budget` default is a **server setting** (env), default off. | Settings live in `src/config/settings.ts` as env vars; a DB-backed Governance page is a larger change. Listed as a follow-up in NOTES. |
| D9 | `context_budget` is **agent-only** in v1. | Scripts, reports and subworkflows are not token-metered; `context:` bundles (not budgets) apply to them. |
| D10 | Continuation **hard-fails** if the checked-out commit is not `from.base_sha`. | The error names both SHAs and tells the author to pin `ref: {ref: nodes.<id>.output.workspace.base_sha}`. No silent fallback to the base. |

## Feature Metadata

**Feature Type**: New Capability (additive, opt-in)
**Estimated Complexity**: High (schema + compiler + sandboxed runtime + worker + API + builder + editor + docs)
**Primary Systems Affected**: `src/definition`, `src/compiler`, `src/runtime`, `src/agents`, `src/worker`, `src/api`, `src/plan`, `src/builder`, `web/`, `examples/`, `docs/`
**Dependencies**: none new. Uses existing `ajv`, `yaml`, `@marcbachmann/cel-js`, git, vitest, `playwright-core` (already used by `test/builder.test.ts`).

---

## CONTEXT REFERENCES

### Relevant Codebase Files. YOU MUST READ THESE BEFORE IMPLEMENTING

Definition layer
- `src/definition/types.ts` (1-56, 57-86, 120-165) - `Value`/`ValueExpr`, `NodeCommon`, `AgentNode`, `AgentWorkspace` (doc comment on `mode`/`test`), `WorkflowDefinition`. New fields go here.
- `src/definition/schema.ts` (1-30 `common`/`node()` with `additionalProperties:false`; 66-103 top-level props and `$defs/value`; 120-170 agent + `workspace`; 172-230 other nodes). Every new field **must** be added or the schema rejects it.
- `src/definition/load.ts` (28-45) - how schema errors become `Diagnostic`s (the `if/then` noise filter).

Compiler
- `src/compiler/compile.ts`
  - 62-100 `nodeValues()` (per-node value sites; drives ref validation, `deps`, `dataDeps`). **Extend this** so bundle/`from` refs become data edges.
  - 125-232 dependency inference, `dataDeps`, ref-root validation (`REF_ROOTS`, line 45), CEL checks, topo sort.
  - 233-260 `loadSchema`, `inputSchemaFor`.
  - 336-394 `case 'agent'`: `workspace_unsupported` (350), `workspace_test_needs_write`, `refSchema` for write-mode workspace (358-370) - **mirror this** for `handoff`.
  - 438-462 `outputs.set(id, refSchema ?? outputSchema)` and `planNodes.set(...)`.
  - 474-495 taint call and `ExecutionPlan` construction (omit new fields when unused).
- `src/compiler/plan.ts` (1-45 `PlanNode`, `ExecutionPlan`; 76-110 `WORKSPACE_CHANGE_SCHEMA` - already engine-owned, reuse it).
- `src/compiler/taint.ts` (all) - taint flows along `dataDeps`; **no change needed** if the new refs land in `dataDeps` (verify with a test).
- `src/compiler/schema-path.ts` - `resolvePath`, `compatible`, `typesOf` for ref typing.

Runtime (Temporal sandbox: deterministic, **no Node-only imports**)
- `src/runtime/values.ts` (all) - `resolveValue`, `resolveRef`, `DeferredRef`. Add `resolveNodeInput` here.
- `src/runtime/workflow.ts`
  - 110 `scope()`; 148-212 `runHarness` (workspace spec built at 150-163, `harnessPrepare` call 164-178, `runHarness` activity 180-200, token 179); 214-258 `runAgent` (`agentBegin` at 224-235).
  - Other `resolveValue(def.input, s)` sites: script 373, report 395, subworkflow 469. Replace all four.
- `src/runtime/activity-types.ts` (84 `harnessPrepare` signature) and `src/runtime/gateway-activities.ts` (230-241 `harnessPrepare`; 30-31 `withChunks`).

Agents
- `src/agents/model-agent.ts`
  - 28-40 `PLATFORM_RULES` (system prompt). 99-123 `AgentBeginInput`. 171-183 `materialise`. 196-249 `agentBegin` (input text 218-221; manifest `item()` 138). 295-298 manifest write. 444-450 `contextSafe` (the existing 8 KiB tool-result ceiling - pattern for the withheld-field shape). 462-504 `harnessPrepare` (calls `agentBegin`, adds harness-owned manifest items, workspace item at ~480).
- `src/config/settings.ts` (63 `storeContextContent` - the env-setting pattern to mirror).

Worker
- `src/worker/workspace.ts` (all): `WorkspaceSpec` (18-33), `Checkout`, `cloneWorkspace` (68-127; clone, `refs/azhi/head`, write-mode moves `.git` to `gitDir`; the new `stall` git config on the fetch at ~96-99 is unrelated, insert the continuation after `head` is read at ~101), `CHANGE_LIMITS`, `WorkspaceChange` (127-138), `stageChange`, `collectChange` (computes diff from `c.head` to the staged tree - so after continuation the new change is **cumulative from the original base**, which is what push tools want).
- `src/worker/harness-activity.ts` (72 `HarnessResult`, 104-150 `runHarness`, 137-147 workspace token + `cloneWorkspace` call) and `src/worker/harness-opencode2.ts` (74-83 same pattern). `src/worker/api-client.ts` - `ApiClient.get`.
- `src/security/tokens.ts` (`signRunToken` claims: `ws, run, node, tools, creds, exp`).
- `src/api/app.ts` (485 `GET /v1/artifacts/:hash`; 679-690 `GET /v1/gateway/credentials/:name` - **the pattern for the new artifact endpoint**).
- `src/testing/fake-git.ts` - fake git host used by `test/workspace-write.test.ts`.

Plan/UI/authoring
- `src/plan/run-plan.ts` (120-160 `opencodeSetup`: workspace `requirements`/`coverage` rows - add continuation and budget rows).
- `src/builder/skill.md` (84 "workflow.yaml reference"; bullets `script` 120, `agent` 123, `subworkflow` 136, `report` 141; 167 "Token usage strategy"; 203 "Rules the compiler enforces"; 216 "Policies and controls to offer"; 228 "Suggest what is available"; 247 "Adding an MCP server"; the new "Changing an existing workflow" paragraph inside step 1 at ~22-40 and the revised step 5 "Revise on request" at ~69).
- `src/builder/builder.ts`: `BuilderProposal` (53-65; `nodes: unknown[]`), `checkProposal` (~555-620; line ~616 builds `nodes: [{id, type, deps, route?, def}]` so **the web already receives each step's `def`**), `applyChange` (merges a patch onto the latest version: `files` replace/add, `remove` deletes), `readWorkflow`/`readWorkflowFile`, the `propose_workflow` handler in `builderTurn` (~710-725) and the post-compile `notes` handed back to the model (~726-735).
- `test/builder-edit.test.ts` - **the pattern for testing patch edits** (registers tools, uploads `examples/sdlc-universal`, calls `readWorkflow`, `applyChange`, `checkProposal` directly with a real PGlite context).
- `web/src/pages/Editor.tsx` (140-150 `renameStep` - **only rewrites inside `nodes`**; 735 `HARNESS_FIELDS`; ~782-977 agent step editor incl. `setBudget` 810, `Workspace` section 963, `Budget` section 968; 989 `WorkspaceFields`; 671 YAML-text helper). The recent change here is only the `WorkflowCanvas` `head`/`foot` props (~342-365); it does not affect these tasks.
- `web/src/components/WorkflowSettings.tsx` (37 `SectionId`; 96-100 `sectionsOf`; 136-180 section rendering) and `web/src/stepHelp.ts` (35 `agent.workspace` help; 94, 115, 188 summaries) - both unchanged since the first draft.
- `web/src/pages/Builder.tsx` (rewritten): `Proposal` type (43-55), `MessageView` draft card (~469-480), and `DraftPanel` (~604-665) whose `draft-facts` list (Status / Steps / Files / To set up / Warnings) and Steps/Files tabs are where draft details show. There is **no** per-step model/limits line in the UI; that text comes from the model's own `summary`.

Examples / docs / tests (patterns)
- `examples/ai-sdlc-v2/workflow.yaml` (the adopter; lines 98-100, 316-318, 416-444, 600-632, 506-522, 903-915).
- `docs/loops-and-subworkflows.md` (feature doc style: short, exact semantics, "not supported" list), `docs/workflow-builder.md`, `docs/phase-2.md:28` (context manifest).
- `test/compiler.test.ts`, `test/taint.test.ts`, `test/loop-subworkflow.test.ts` (compile + Temporal run pattern, `startHarness`, `uploadDir`, `waitForRun`), `test/workspace-write.test.ts` (fake git + `cloneWorkspace`), `test/builder.test.ts` (scripted builder model, `startFakeAnthropic`, `FakeStep`, Playwright), `test/opencode2.test.ts` / `test/harness-executors.test.ts` (harness wiring), `test/gate2.test.ts` (golden plan), `test/ai-sdlc-v2.test.ts`.

### New Files to Create

- `src/compiler/contexts.ts` - bundle helpers shared by the compiler (static collision/shape checks).
- `src/agents/context-budget.ts` - pure `applyContextBudget()`.
- `docs/context-sharing.md` - the feature doc (one file per feature).
- `examples/context-review-revise/` - a **non-SDLC** installable example (research -> draft -> critique -> revise) using all four features (also the fixture for tests).
- `test/context-bundles.test.ts`, `test/context-budget.test.ts`, `test/workspace-continuation.test.ts`, `test/handoff.test.ts`, `test/context-regression.test.ts`.

### Relevant Documentation

- Temporal TypeScript determinism rules and payload limits: https://docs.temporal.io/develop/typescript/core-application#workflow-logic-requirements and https://docs.temporal.io/troubleshooting/blob-size-limit-error - why workflow code must stay pure and why the change goes through the artifact store (2 MB blob limit).
- git fetch by SHA / `uploadpack.allowReachableSHA1InWant`: https://git-scm.com/docs/git-config#Documentation/git-config.txt-uploadpackallowReachableSHA1InWant - only relevant to the documented "pin `ref` to `base_sha`" advice; the fake git server used in tests needs this enabled for that case.

### Patterns to Follow

**Optional plan fields are omitted when unused** (`compile.ts:482-490`):
```ts
...(opts.pkg ? { packageHash: opts.pkg.hash } : {}),
...(def.inputs ? { inputsSchema: def.inputs } : {}),
```
Do the same for `contexts`.

**Diagnostics** (`compile.ts` `err(code, message, nodeId, path)` / `warn(...)`): snake_case codes, messages name the node and quote the offending value, e.g. `err('workspace_output', "output_schema may not declare 'workspace': ...", n.id, 'output_schema')`.

**Engine-added output field for downstream refs** (`compile.ts:358-370`): `refSchema = { ...outputSchema, properties: { ...props, workspace: WORKSPACE_CHANGE_SCHEMA }, required: [...] }`. Mirror for `handoff` (but `handoff` is optional, not required, and also goes into the schema the agent submits against).

**Run-token capability claim** (`src/api/app.ts:679-690`): `if (!c.creds?.includes(name)) throw authorization`. Mirror with `c.arts`.

**Env settings** (`settings.ts:63`): `process.env.AZHI_... ` parsed once into the settings object.

**Errors**: `new AzhiError(ErrorClass.budgetExceeded | contractViolation | invalidInput, msg)` in server code; `ApplicationFailure.create({ type: ErrorClass.x, message, nonRetryable: true })` in worker/workflow code.

**Unknown stays unknown**: token counts for withheld/kept fields are `chars/4` and must be labelled `estimated` in the manifest (`token_source`), never presented as reported.

**Comments**: match the surrounding density (a short doc comment on exported items, rationale-only inline comments). No unrelated refactors.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation - definition schema and types
Add the four fields to types and JSON Schema. Nothing behaves differently until used.

### Phase 2: Compiler
Bundle expansion into data edges and checks; `workspace.from` checks; `handoff` output schema; plan field `contexts`.

### Phase 3: Runtime
Deterministic input resolution with bundles in the workflow sandbox; budget and per-field manifest in `agentBegin`; handoff instruction; continuation plumbing (server activity -> artifact -> worker).

### Phase 4: Worker and API
`cloneWorkspace` applies a continuation safely; artifact endpoint and run-token claim; both OpenCode adapters pass it.

### Phase 5: Authoring surfaces
Run plan rows; builder skill + draft summary; visual editor (Contexts section, step pickers, rename fix).

### Phase 6: Proof and adoption
Non-SDLC example; unit/integration/regression/builder/UI tests; docs; migrate `ai-sdlc-v2` last.

---

## STEP-BY-STEP TASKS

Execute in order. After every task run its VALIDATE command; do not continue on failure.

### 1. UPDATE `src/definition/types.ts`
- **IMPLEMENT**:
  - `WorkflowDefinition.contexts?: Record<string, Record<string, Value>>` with a doc comment ("named sets of upstream fields a node pulls in with `context`").
  - `context?: string[]` on `AgentNode`, `ScriptNode`, `SubworkflowNode`, `ReportNode` (not on `NodeCommon`; other node types have no `input`).
  - `AgentNode.context_budget?: { max_item_bytes?: number; max_total_tokens?: number }` and `AgentNode.handoff?: { max_chars: number }`.
  - `AgentWorkspace.from?: Value` ("start from the change a previous write-mode step made: `{ref: nodes.<id>.output.workspace}`").
- **PATTERN**: doc-comment style of `AgentWorkspace.mode` (`types.ts:84-88`).
- **GOTCHA**: `ref` stays required on `AgentWorkspace`; with `from` it is still fetched and must resolve to `from.base_sha` (D10).
- **VALIDATE**: `npm run typecheck`

### 2. UPDATE `src/definition/schema.ts`
- **IMPLEMENT**: top-level `contexts` (`type: object`, `propertyNames: id`, each value an object whose keys match `^[A-Za-z_][A-Za-z0-9_]*$` and values are `{ $ref: '#/$defs/value' }`, `minProperties: 1`); a shared `contextProp = { type: 'array', items: id, uniqueItems: true, minItems: 1 }` added to `scriptProps`, the `agent` props, `subworkflow` and `report`; agent `context_budget` (`max_item_bytes` integer >= 256, `max_total_tokens` integer >= 100, `additionalProperties:false`, `minProperties: 1`) and `handoff` (`max_chars` integer 1..8000, required); `workspace.from: { $ref: '#/$defs/value' }`.
- **PATTERN**: `budget` (`schema.ts:129-138`) and `workspace` (`142-163`).
- **GOTCHA**: `node()` sets `additionalProperties:false`, so each new key must be listed per node type. `workspace.required` stays `['repo','ref']`.
- **VALIDATE**: `npx vitest run test/compiler.test.ts` (existing schema tests must still pass)

### 3. CREATE `src/compiler/contexts.ts`
- **IMPLEMENT**: pure helpers, no side effects:
  - `contextBundles(def)`: normalised `Record<string, Record<string, Value>>`.
  - `contextKeysOf(def, nodeContext: string[])`: ordered list of `{bundle, key}`.
  - `literalInputKeys(input: Value | undefined)`: top-level keys when `input` is a plain object literal (not a `ValueExpr`), else `undefined`.
  - `contextCollisions(...)`: duplicates across bundles and against literal input keys, returned as messages.
- **IMPORTS**: `isValueExpr`, `Value`, `WorkflowDefinition` from `../definition/types.js`.
- **GOTCHA**: compiler-only; the runtime merge lives in `values.ts` (sandbox rules).
- **VALIDATE**: `npm run typecheck`

### 4. UPDATE `src/compiler/compile.ts` - bundles as data edges
- **IMPLEMENT**:
  - Extend `nodeValues(n, contexts?)` (`compile.ts:62`): for `agent|script|subworkflow|report` nodes with `n.context`, add one entry per bundle key at path `context.<bundle>.<key>`; for agents with `workspace.from`, add `'workspace.from'`. Pass `def.contexts` at the call site (~line 158).
  - Before node processing, validate: `unknown_context` (name not in `contexts`), `context_collision` (use `contextCollisions`), `context_input_shape` (`input` is a literal array/scalar while `context` is set), `invalid_context_ref` (bundle values may not use `item`, `state`, `iteration` - the existing root checks at lines 169-181 already raise `invalid_ref` since those sites are not inside a parallel/loop body; confirm the message makes sense), warning `unused_context` for a bundle no node references.
  - Emit `contexts` on the `ExecutionPlan` only when the definition has any (`compile.ts:482`), and add `contexts?: Record<string, Record<string, Value>>` to `ExecutionPlan` in `src/compiler/plan.ts`.
- **PATTERN**: ref/CEL handling loop `compile.ts:157-205`; conditional spread at 482-490.
- **GOTCHA**: type-checking uses `refTypes` keyed by `site.path`, so the `context.<bundle>.<key>` path must be unique per site. Bundle entries on `merge: any` nodes may reference nodes on alternative routes; resolution at run time yields `undefined` for a node that did not run, and CEL `nodes.x.output` on a skipped node throws, which is the same behaviour as today's `input` maps (document: guard with `has(...)`).
- **VALIDATE**: `npx vitest run test/compiler.test.ts test/taint.test.ts`

### 5. UPDATE `src/compiler/compile.ts` - `workspace.from` and `handoff`
- **IMPLEMENT** in `case 'agent'` (`compile.ts:344`):
  - `workspace.from` (only when `n.workspace`): must be `{ref: 'nodes.<id>.output.workspace'}` exactly, where `<id>` exists, is an agent node, `<id> !== n.id`, and `byId.get(id).workspace?.mode === 'write'`; otherwise `err('workspace_from_invalid', ..., n.id, 'workspace.from')`. A literal `from` without `workspace` is a schema/`workspace_from_needs_workspace` error. The executor restriction already comes from `workspace_unsupported` (line 350).
  - `handoff`: require object `output_schema` (`handoff_output` error otherwise, like `workspace_output`); error if the schema already declares `handoff`; otherwise set `outputSchema = {...outputSchema, properties: {...props, handoff: {type:'string', maxLength: n.handoff.max_chars}}}` (not added to `required`). Compose with the write-mode `refSchema` so downstream refs see both `workspace` and `handoff`.
- **PATTERN**: `compile.ts:358-370`.
- **GOTCHA**: `planNodes.set(... outputSchema ...)` (`compile.ts:451`) is what the agent **submits against** (`agentBegin` -> `outputSchema`, `model-agent.ts:213`). The handoff property must be in **that** schema (many package schemas use `additionalProperties:false`, e.g. `test/builder.test.ts:20`), and in `outputs.set` for downstream type-checking. The write-mode `workspace` field stays only in `refSchema`.
- **VALIDATE**: `npx vitest run test/compiler.test.ts` (new cases are added in task 24)

### 6. UPDATE `src/runtime/values.ts` - `resolveNodeInput`
- **IMPLEMENT**: `resolveNodeInput(input: Value | undefined, context: string[] | undefined, contexts: Record<string, Record<string, Value>> | undefined, scope: ValueScope): { value: unknown; parts?: Array<{ key: string; source: string }> }`.
  - No `context` -> `{ value: resolveValue(input, scope) }` (byte-identical to today; this is the backward-compat guarantee).
  - With `context`: resolve each bundle key in declaration order, then the node `input`. `input` must resolve to a plain object or `undefined`/`null`; otherwise throw `ApplicationFailure.create({ type: 'contract_violation', nonRetryable: true, message })` naming the node. A key present in both bundle and input, or in two bundles, throws the same. Result is `{...bundleKeys, ...inputKeys}`; `parts` lists each key with `source` `context:<bundle>` or `input`.
- **PATTERN**: `resolveValue` in the same file. Keep it pure; no Node imports.
- **GOTCHA**: resolved values may be `DeferredRef` (`$artifact_path`) - leave them untouched; `materialise` expands them in the activity.
- **VALIDATE**: `npx vitest run test/context-bundles.test.ts` (task 22)

### 7. UPDATE `src/runtime/workflow.ts` - use `resolveNodeInput`
- **IMPLEMENT**: at the agent sites (`workflow.ts:172`, `:232`) call `resolveNodeInput(def.input, def.context, plan.contexts, s)` and pass `input: r.value ?? null`, `inputParts: r.parts`, `contextBudget: def.context_budget`, `handoff: def.handoff` into `harnessPrepare` / `agentBegin`; at script (`:373`), report (`:395`) and subworkflow (`:469`) replace `resolveValue(def.input, s)` with `.value` (those have no budget/parts).
- **GOTCHA**: only these four node types accept `context` (schema). Do not touch the parallel/loop inner `node.input` sites (430, 456).
- **VALIDATE**: `npm run typecheck && npx vitest run test/loop-subworkflow.test.ts`

### 8. CREATE `src/agents/context-budget.ts` + UPDATE `src/agents/model-agent.ts`
- **IMPLEMENT** `applyContextBudget(input: unknown, limits: {maxItemBytes?: number; maxTotalTokens?: number}, store: (json: string) => string): { input: unknown; withheld: Array<{ key: string; bytes: number; artifact: string; reason: string }>; estimatedTokens: number }`:
  - Non-object input -> treated as one item `input`.
  - Per-item pass: a top-level key whose `JSON.stringify` bytes exceed `maxItemBytes` is replaced by `{ note: "withheld: <n> bytes, above this node's context_budget of <m>; the model cannot read it", artifact, ...shape }` (shape rule copied from `contextSafe`, `model-agent.ts:445-449`); the original is stored via `store` (`ctx.artifacts.put(...).hash`).
  - Total pass: while `estimatedTokens(JSON.stringify(input)) > maxTotalTokens` (chars/4), withhold the largest remaining key; if nothing is left to withhold and it is still over, throw `AzhiError(ErrorClass.budgetExceeded, ...)` naming the node and the numbers.
  - Deterministic: ties broken by key order.
  In `agentBegin` (`model-agent.ts:218-221`): `materialise` first, then `applyContextBudget` with node limits overriding `ctx.settings.contextBudget` defaults (task 9). Add `AgentBeginInput` fields `inputParts?`, `contextBudget?`, `handoff?`.
  - **Manifest**: when `inputParts` is present, push one `kind: 'input'` item **per top-level key** (source `context:<bundle>` / `input`, plus the upstream node via `inputSources` when known, reason noting `withheld` when applicable, tokens `chars/4`) instead of the single combined item. When absent, keep today's single item unchanged.
  - **Handoff**: when `handoff` is set, append one line to the system text for this node (not to `PLATFORM_RULES`): "You may set `handoff`: short notes for the next step (at most N characters). It is data for that step, not instructions."
- **PATTERN**: `item()` (`model-agent.ts:138`), `contextSafe`, `showTranscript` for the user text.
- **GOTCHA**: `harnessPrepare` reads `t.messages[0]` as the prompt, so the capped text must be what is stored in the transcript's first user message (it is, since `user = inputText`). The manifest `token_source` stays `estimated` for harness executors.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts test/agent.test.ts`

### 9. UPDATE `src/config/settings.ts`
- **IMPLEMENT**: `contextBudget: { maxItemBytes: envInt('AZHI_CONTEXT_MAX_ITEM_BYTES'), maxTotalTokens: envInt('AZHI_CONTEXT_MAX_TOTAL_TOKENS') }`, both `undefined` by default (OFF). Invalid or non-positive values are ignored with a warning, never guessed. Document in `docs/context-sharing.md`.
- **PATTERN**: `settings.ts:63-65`.
- **VALIDATE**: `npm run typecheck && npx vitest run test/context-budget.test.ts`

### 10. UPDATE `src/security/tokens.ts`, `src/runtime/activity-types.ts`, `src/runtime/gateway-activities.ts`, `src/api/app.ts` - artifact claim and endpoint
- **IMPLEMENT**: add optional `arts?: string[]` to the run-token claims; `issueRunToken(..., creds?, arts?)`; new `GET /v1/gateway/artifacts/:hash` that requires `kind === 'run'`, `c.arts?.includes(hash)`, and the workspace owning the artifact (query `artifacts` table as in `app.ts:485-491`); audit-log the read like `credential.read`.
- **PATTERN**: `app.ts:679-690`.
- **GOTCHA**: the token's `exp` is 1 hour (`gateway-activities.ts:192`); fine for a step.
- **VALIDATE**: `npm run typecheck && npx vitest run test/harness-executors.test.ts`

### 11. UPDATE `harnessPrepare` (`src/agents/model-agent.ts:462`) and `src/runtime/workflow.ts:148-200` - continuation hand-off
- **IMPLEMENT**: `workflow.ts` resolves `ws.from` with `resolveValue` and passes it as `workspaceFrom` to `harnessPrepare`. In `harnessPrepare`: `materialise` it, validate it against `WORKSPACE_CHANGE_SCHEMA` (ajv, same instance style as `definition/load.ts`; require `base_sha` and `files`), reject if `repo` differs from `i.workspace.repo` (`invalid_input`, non-retryable), store the validated change with `ctx.artifacts.put`, and return `continuation: { artifact, base_sha, files: n }`. `workflow.ts` adds `continuation` (artifact + baseSha) to the `workspace` object passed to the worker `runHarness`, and adds the hash to the run token's `arts`. Manifest: extend the workspace item (`model-agent.ts:~480`) reason with "continued from <n> files of nodes.<id>".
- **GOTCHA (D6)**: never put `files` content in the Temporal payload. Only `{artifact, baseSha}` goes to the worker.
- **VALIDATE**: `npm run typecheck`

### 12. UPDATE `src/worker/workspace.ts` - apply a continuation
- **IMPLEMENT**: `WorkspaceSpec.continuation?: { baseSha: string; change: WorkspaceChange }`. In `cloneWorkspace`, after checkout and `head` is known and **before** the write-mode `.git` move: if `continuation` and `head !== baseSha` -> `ApplicationFailure.create({ type: ErrorClass.invalidInput, nonRetryable: true, message: "workspace ref <ref> is at <head>, but the change to continue was made on <baseSha>; pin ref to the change's base: ref: {ref: nodes.<id>.output.workspace.base_sha}" })`. Then apply each `files[]` entry: `deleted` -> unlink (missing file is an error); `added|modified` -> write `content` (`utf-8` or `base64`) and `chmod` 0o755 for `100755`.
  - **Path safety (the change is agent-written, i.e. untrusted)**: reject (`contract_violation`, non-retryable) any path that is absolute, contains `..`, a backslash, a NUL byte, or any segment equal to `.git` (case-insensitive), or whose resolved target is outside `dir`; create parent directories with `mkdirSync(..., {recursive:true})` after verifying no existing parent is a symlink (`lstat`). Enforce `CHANGE_LIMITS.files` / `contentBytes`.
- **PATTERN**: `REF`/`REPO` validators and `invalid()` helper at the top of the file; `collectChange` for field names.
- **GOTCHA**: `core.symlinks=false` is already set, so the base tree has no symlinks; still `lstat`-check parents because the change could add a path under a file that the base has as a regular file. Files absent from `files[]` stay as the base has them.
- **VALIDATE**: `npx vitest run test/workspace-continuation.test.ts` (task 23)

### 13. UPDATE `src/worker/harness-activity.ts` and `src/worker/harness-opencode2.ts`
- **IMPLEMENT**: when `input.workspace.continuation` is set, fetch `GET /v1/gateway/artifacts/<hash>` with `runApi`, parse, pass as `spec.continuation = { baseSha, change }` to `cloneWorkspace` (v1 call `harness-activity.ts:145`, v2 call `harness-opencode2.ts:82`). Add `continuation?: { artifact: string; baseSha: string }` to the `HarnessInput` workspace type.
- **PATTERN**: the credential fetch directly above each `cloneWorkspace` call.
- **GOTCHA**: both adapters must behave identically; share the fetch in a small helper in `workspace.ts` rather than duplicating.
- **VALIDATE**: `npm run typecheck && npx vitest run test/opencode2.test.ts test/opencode.test.ts`

### 14. UPDATE `src/plan/run-plan.ts`
- **IMPLEMENT**: in `opencodeSetup` add a `coverage` row for `workspace.from` ("starts from the change made by <node>; applied on the worker after checkout, base commit must match"); for any agent with a context budget (node or server default) add a row listing the limits; list bundles used by the node in its plan `requirements`/notes so the editor's plan dock shows them.
- **PATTERN**: `run-plan.ts:128-150`.
- **VALIDATE**: `npx vitest run test/gate2.test.ts` (golden must be unchanged because `quality-report` uses none of this)

### 15. UPDATE `src/builder/skill.md`
- **IMPLEMENT**:
  - In the `workflow.yaml` reference: add a top-level `contexts:` entry with a 6-line example; in the `agent` bullet (~line 123) document `workspace` (repo, ref, credential, depth, mode, test, `from`; OpenCode only), `context`, `context_budget`, `handoff`; add `context: [names]` to the `script`, `subworkflow` and `report` bullets (~120, 136, 141).
  - New section **"## Sharing context between steps"** placed after "Policies and controls to offer" (~216) and before "Suggest what is available" (~228), so it sits with the other design guidance and not in the interview steps. Rules, each one sentence: two or more steps need the same upstream fields -> define a `contexts` bundle instead of repeating a map; a revise/fix step after a write-mode agent -> `workspace.from`, never the diff in `input`; a step whose input can hold documents, diffs or tool dumps -> `context_budget`; the next agent needs the previous agent's reasoning -> `handoff`, never transcripts; never invent a way to pass context that is not listed here.
  - Tie it to the token-usage guidance ("Token usage strategy", ~167): Economical sets tight `context_budget` values, Highest quality leaves it unset.
  - **Editing an existing workflow** (the new step-1 paragraph, ~22-40): add one sentence that in a changed `workflow.yaml` the model must keep the `contexts:` block and every node's `context:` list unless the change is about them, and that renaming or dropping a bundle means updating every node that lists it. This matters because a change rewrites whole files and the model could drop the block; the compiler's `unknown_context` error is the safety net that sends it back.
  - Add the new compile errors (`unknown_context`, `context_collision`, `context_input_shape`, `workspace_from_invalid`, `handoff_output`) to "Rules the compiler enforces" (~203).
- **PATTERN**: existing bullet/reference style in `skill.md`.
- **GOTCHA**: `skill.md` is read once at server start (`readFileSync(new URL('./skill.md', ...))`, `builder.ts`), so tests that assert on its text read the file directly. Keep the new section short; the whole skill is sent on every builder turn and adds to every user's token bill.
- **VALIDATE**: `npx vitest run test/builder.test.ts test/builder-edit.test.ts`

### 16. UPDATE `src/builder/builder.ts` - draft summary and examples
- **IMPLEMENT**: `checkProposal` already returns `nodes[].def` (`builder.ts:~616`), and the web `Proposal` type already carries `nodes`, so **no new API shape is needed**. Add the context details to the `notes` handed back to the model after a successful compile (the `propose_workflow` branch of `builderTurn`, ~726-735), as lines like "step `revise` continues from `draft`'s workspace; step `critique` caps context at N bytes; bundle `brief` is used by 3 steps", so the model's plain-language summary mentions them. Put the summarising logic in one small exported function (for example `contextNotes(nodes)` in `src/builder/builder.ts` or a new `src/builder/context-notes.ts`) so the web can reuse the same wording rules in Task 17 without importing server code: duplicate the 15-line formatter in `web/` instead of importing, matching how `stepHelp.ts` duplicates logic today.
  - Do **not** change `applyChange`/`readWorkflow`: they treat `workflow.yaml` as opaque text. Contexts survive a patch edit as long as the model keeps the block, which Task 15's rule asks for and the compiler enforces.
  - `workspace_overview` lists examples from `examples/`, so `context-review-revise` (Task 20) is discoverable by the model through `read_example` without code changes. Confirm in a test.
- **VALIDATE**: `npx vitest run test/builder.test.ts test/builder-edit.test.ts`

### 17. UPDATE `web/src/pages/Builder.tsx` (draft card/panel)
- **IMPLEMENT**: in `DraftPanel` (~604-665): (a) add one `draft-facts` entry **Shared context** (`<n> bundles · <n> steps use them`, or `none`; shown only when the draft uses any of the four features, so unrelated drafts look exactly as before); (b) under the facts, a short `muted small` list, one line per step that uses any feature: "`revise`: shared context `brief` · continues from `draft` · cap 8 KB per item · handoff 500 chars". Read everything from `p.nodes[].def` and the workflow's `contexts` (parse it from `p.files['workflow.yaml']` with the `yaml` package already imported in `Editor.tsx`, or have the server include `contexts` in the proposal; prefer the former to avoid an API change). The draft **card** in `MessageView` (~472-480) stays as is.
  - There is no existing per-step model/limits line to extend (the first draft of this plan assumed one); the model's `summary` text carries that.
  - Since the builder can now edit an existing workflow, the panel title reads "Save as a new draft of <id>"; make sure the facts row also appears for patch edits.
- **PATTERN**: the other `draft-facts` entries and the `draft-todo`/`draft-warnings` lists (Builder.tsx:625-645); styles in `web/src/styles.css` (restyled recently: reuse existing classes, add none unless needed).
- **VALIDATE**: `npm run typecheck && npm run build:web`

### 18. UPDATE `web/src/pages/Editor.tsx` - rename fix and agent fields
- **IMPLEMENT**:
  - `renameStep` (`:140-150`): the function returns `{...def, nodes: ...}`, so `def.contexts` is carried over untouched; add `contexts: swap(def.contexts)` using the same `swap` regex (`nodes.<from>` -> `nodes.<to>`); `workspace.from` is inside each node's `rest` and is already swapped. Omit the key when `def.contexts` is undefined so existing workflows' YAML does not change. Keep key order.
  - Agent step editor (`~:963-977`): new `HbSection`s **Shared context** (multi-select of defined bundles; hidden if the workflow has none), **Context budget** (two number inputs, empty = unset, mirror the Budget section at `:968-977` and `setBudget` at `:810`), **Handoff** (number input; empty removes the key). In `WorkspaceFields` (`:989`) add a "Continue from" select listing earlier write-mode agent steps; choosing one sets `from: {ref: nodes.<id>.output.workspace}`. Add `context`, `context_budget`, `handoff` to the agent field handling so unknown keys are preserved (`HARNESS_FIELDS`, `:735`).
  - Script/report/subworkflow editors: the same "Shared context" picker.
- **PATTERN**: `setBudget` and `set(...)` helpers (`:805-815`).
- **GOTCHA**: preserve unknown keys and key order so saved YAML diffs stay small (`reorder`, `:156-160`). `WorkflowCanvas` now takes `head`/`foot` props (recent restyle): do not touch the canvas wiring, only the step drawer content.
- **VALIDATE**: `npm run typecheck && npx vitest run test/editor.test.ts`

### 19. UPDATE `web/src/components/WorkflowSettings.tsx` and `web/src/stepHelp.ts`
- **IMPLEMENT**: add `'contexts'` to `SectionId` (`:37`) and `sectionsOf` (`:96`): summary lists bundle names with field counts, chip = count; the popup edits each bundle as name -> key -> value (ref picker reusing the existing "Gets" pickers from `ConfigRow`), with an inline warning for bundles no step uses. Add help strings in `stepHelp.ts` (`agent.context`, `agent.context_budget`, `agent.workspace.from`, `agent.handoff`) and step summaries (`:94`, `:115`, `:188`).
- **VALIDATE**: `npm run typecheck && npm run build:web && npx vitest run test/step-help.test.ts test/web.test.ts`

### 20. CREATE `examples/context-review-revise/` (non-SDLC fixture and example)
- **IMPLEMENT**: a small installable workflow that is **not** software delivery: `research` (agent) -> `draft` (agent, `handoff`) -> `critique` (agent, `context_budget`) -> `revise` (agent) with one `contexts:` bundle (`brief`) reused by three steps. Include `workflow.yaml`, `profiles/*.yaml` (scripted/model-agent provider so it runs without OpenCode), `schemas/*.json`, `README.md`. A second variant `workflow.code.yaml` (or a second example dir) shows `workspace.from` with `executor: opencode` for the draft-review-revise-on-a-repo case; keep it compile-only in tests (OpenCode is not run in CI).
- **PATTERN**: another example's layout, e.g. `examples/ai-sdlc-v2/` and `examples/pr-review/`; check how examples register for install (`src/api/examples.ts`, `test/fixtures/examples`).
- **VALIDATE**: `npx vitest run test/example-merge.test.ts test/example-update.test.ts`

### 21. UPDATE `examples/ai-sdlc-v2/` - migrate as an adopter (LAST code change)
- **IMPLEMENT**: add `contexts: delivery_brief` (`ticket`, `requirements`, `design`, `decisions`) and `environment`; replace the repeated maps in `build*`, `lite_fix*`, `lite_review_*`, `lite_verify_*` with `context: [delivery_brief]` plus only their own keys; give the fix nodes `workspace.from: {ref: nodes.<build-variant>.output.workspace}` ... **but** the fix round consumes `change_1` (a script that picks among three build variants), whose output is not a node with `workspace.mode: write` (task 5's `workspace_from_invalid`). Resolve by extending the rule to accept a `script` node whose `output_schema` declares a compatible `workspace` property **only if** the script is a pure selector; if that proves too loose, keep the existing diff-in-prompt path for the fix round and migrate only the bundles in v1 (record the decision in NOTES). Update `implement-change/SKILL.md` and `harness/commands/implement.md` only if the fix round switches to continuation.
- **GOTCHA**: `ai-sdlc-v2` has tests (`test/ai-sdlc-v2.test.ts`, `ai-sdlc-v2-finalize.test.ts`, `ai-sdlc-e2e.test.ts`) and a CHANGELOG (`examples/ai-sdlc-v2/CHANGELOG.md`): bump and describe. The compiled graph (nodes, edges, taint paths) must be unchanged.
- **VALIDATE**: `npx vitest run test/ai-sdlc-v2.test.ts test/ai-sdlc-v2-finalize.test.ts test/ai-sdlc-e2e.test.ts`

### 22. CREATE `test/context-bundles.test.ts` and `test/context-regression.test.ts`
- **IMPLEMENT**: see Testing Strategy. Regression test compiles every `examples/*/` and the `test/fixtures` packages with the new code and asserts the plan JSON equals a stored snapshot **produced before this change** (take the snapshot first - see Task 0 note in VALIDATION).
- **VALIDATE**: `npx vitest run test/context-bundles.test.ts test/context-regression.test.ts`

### 23. CREATE `test/context-budget.test.ts`, `test/workspace-continuation.test.ts`, `test/handoff.test.ts`
- See Testing Strategy.
- **VALIDATE**: `npx vitest run test/context-budget.test.ts test/workspace-continuation.test.ts test/handoff.test.ts`

### 24. UPDATE `test/compiler.test.ts`, `test/taint.test.ts`, `test/builder.test.ts`, `test/builder-edit.test.ts`, `test/editor.test.ts`
- See Testing Strategy. `test/builder-edit.test.ts` gets a second `it`: upload `examples/context-review-revise`, `applyChange` a patch that changes only one profile and assert `workflow.yaml` (with its `contexts:` block) is carried over byte-for-byte; then `checkProposal` a patch that rewrites `workflow.yaml` **without** the `contexts:` block and assert it fails with `unknown_context` (the safety net the skill rule relies on).
- **VALIDATE**: `npx vitest run test/compiler.test.ts test/taint.test.ts test/builder.test.ts test/builder-edit.test.ts test/editor.test.ts`

### 25. CREATE `docs/context-sharing.md`; UPDATE `docs/workflow-builder.md`, `docs/phase-2.md`, `README.md` (link only)
- **IMPLEMENT**: follow `docs/loops-and-subworkflows.md` structure: one section per mechanism with a YAML snippet, exact semantics, error codes, the "not supported / rejected" list, the D4 honesty note (withheld fields cannot be read by the agent), the server env settings (task 9), executor support table (OpenCode only for `workspace.from`), and a "how to adopt in an existing workflow" 5-line recipe. In `docs/workflow-builder.md` add a "## Shared context" section **between** "Suggesting what is available, and adding MCP servers" and "## API" (what the builder proposes and when; that changes to an existing workflow keep `contexts:` because the model is told to and the compiler rejects a dangling `context:`; the draft panel's "Shared context" fact), and tie one sentence into "## Token usage" (Economical sets `context_budget`). Add a line to `docs/phase-2.md:28` (the manifest has per-field input items when `context` is used).
- **VALIDATE**: `npx vitest run test/bundle-inventory.test.ts` (docs referenced by the inventory, if any), then manual proofreading

---

## TESTING STRATEGY

Framework: vitest. Run on PGlite with `npm run test:local`. Compile-only tests need no Temporal; run tests use `startHarness` and are skipped when Temporal is unavailable (`temporalAvailable()` pattern from `test/loop-subworkflow.test.ts`, `test/builder.test.ts`).

### Unit Tests
- `resolveNodeInput`: no `context` -> identical to `resolveValue`; bundle keys first, node keys after; collision (bundle vs input, bundle vs bundle) throws `contract_violation`; non-object `input` + `context` throws; `DeferredRef` passes through untouched; deterministic across calls.
- `applyContextBudget`: per-item withhold; total-token withhold largest-first with stable tie-break; still-over -> `budgetExceeded`; non-object input; unknown/absent limits -> input returned unchanged (reference-equal); withheld note shape matches `contextSafe`.
- `cloneWorkspace` continuation (fake git, mirror `test/workspace-write.test.ts`): add/modify/delete/base64/mode 755; cumulative `collectChange` afterwards (a second change on top yields one diff from the original base); SHA mismatch hard-fails with both SHAs named; every unsafe path form rejected (`../x`, absolute, `.git/hooks/pre-commit`, `A/.GIT/x`, backslash, NUL, symlinked parent); size limits.
- `handoff`: schema with `additionalProperties:false` accepts `handoff`; over `max_chars` is a validation error and goes through the repair turn; non-object schema and a user-declared `handoff` are compile errors.

### Integration Tests
- Compile: all new diagnostics (`unknown_context`, `context_collision`, `context_input_shape`, `unused_context`, `workspace_from_invalid`, `workspace_from_needs_workspace`, `workspace_unsupported` for non-OpenCode executors, `handoff_output`), and positive cases for each of the four node types taking `context`.
- **Taint** (the main risk): a bundle referencing an untrusted tool output makes the consuming agent tainted and an ungated write after it a `tainted_write_ungated` error, exactly as with an inline ref; same for `workspace.from` chains (taint flows from the producing agent).
- Run against Temporal with the model-agent and the scripted provider: the `context-review-revise` example runs end to end; the manifest (`GET` run context manifest, see `docs/phase-2.md:28`) has one `input` item per field with the right sources; an over-budget field is withheld and the node still succeeds; a total over-budget input fails with `budget_exceeded`.
- OpenCode wiring (mirror `test/opencode2.test.ts`, `test/harness-executors.test.ts`): both adapters receive a `continuation` and call `cloneWorkspace` with it; the Temporal payload to `runHarness` contains `{artifact, baseSha}` and **no file content** (assert serialized size).
- API: `GET /v1/gateway/artifacts/:hash` allows only hashes in the token's `arts`, only for run tokens, only in the owning workspace.
- Builder (scripted model, `test/builder.test.ts` pattern): the skill text contains the new reference and the "Sharing context between steps" section; a scripted draft-review-revise proposal using `workspace.from` + a bundle compiles and the post-compile notes list them; a proposal with a bad `workspace.from` is sent back with the compiler error.
- Builder **edits** (`test/builder-edit.test.ts` pattern, real PGlite context, no model): a patch that changes one file carries `workflow.yaml` and its `contexts:` block over unchanged; a patch that rewrites `workflow.yaml` without `contexts:` while nodes still list `context:` fails with `unknown_context`; a patch that adds `context:` to a node of an existing workflow compiles.
- **Backward compatibility**: `test/context-regression.test.ts` compiles every example and fixture package and compares plan JSON to a snapshot taken **before** the change; `test/gate2.test.ts` golden must not change.
- Editor: renaming a step rewrites refs inside `contexts:` and `workspace.from`; saving preserves unknown keys; picking a bundle/continuation produces the expected YAML.

### Edge Cases
- `input` absent but `context` set (input is the bundle alone); `input: null`; `input` as `{ref}` resolving to an object; `{map}` returning a non-map.
- Bundle referencing a node on a skipped route in a `merge: any` consumer (guarded with `has()` vs unguarded).
- Same bundle used by nodes inside and after a condition route.
- A bundle key whose value is an artifact handle > 256 KB; `context_budget` on a `DeferredRef` field.
- `max_item_bytes` smaller than any field (everything withheld) and `max_total_tokens` smaller than the fixed overhead (clear error).
- Continuation where the previous change deleted a file the base has, added a file under a new directory, or touched a binary file; empty `files[]` (valid, no-op); `diff_truncated: true` (continuation still exact because it uses `files`).
- `workspace.from` on a `read`-mode node (review): the applied files are present; `.git` stays in the checkout, so confirm no `.git` path can be written.
- Retried node attempt re-fetches the same artifact and re-applies (idempotent: fresh checkout every attempt).
- Replay safety: `resolveNodeInput` called twice with the same scope returns deep-equal results.

### E2E / Browser Automation

`CLAUDE.md` does not mention an `agent-browser` skill and none is installed in this repo; use **Playwright via `playwright-core`**, exactly as `test/builder.test.ts` and `test/web.test.ts` do (Chromium is preinstalled at `/opt/pw-browsers/chromium`).

- Happy path: open `/ui/workflows/<slug>/edit` for a draft with two agent steps -> add a bundle in **Contexts**, select it on a step, set a budget and handoff, rename the producing step -> assert the YAML pane shows `context: [..]`, the renamed refs inside `contexts:`, and the plan dock shows no errors.
- Builder path: `/ui/workflows/new` with the scripted model proposing a draft-review-revise workflow -> assert the draft panel shows the "Context" line per step and the **Save draft and open the editor** flow opens it.
- Error paths: choose a bundle name that does not exist (hand-edited YAML) -> editor shows `unknown_context`; set `Continue from` to a read-mode step -> not offered.
- Screenshots: save to `screenshots/context-sharing-editor.png`, `context-sharing-builder.png`, `context-sharing-error.png` (gitignored dir, include paths in the report).

---

## VALIDATION COMMANDS

**Before touching code**, snapshot the baseline for the regression test: write a throwaway script (scratchpad, not committed) that compiles every package under `examples/` and `test/fixtures/` with the **unmodified** compiler and stores the plan JSON (with `packageHash`/`definitionHash` kept) under `test/golden/context-regression/`; commit it in the same commit as `test/context-regression.test.ts`.

### Level 1: Syntax & Style
```bash
npm run typecheck
```

### Level 2: Unit Tests
```bash
npx vitest run test/compiler.test.ts test/taint.test.ts test/context-bundles.test.ts test/context-budget.test.ts test/handoff.test.ts test/workspace-write.test.ts test/workspace-continuation.test.ts
```

### Level 3: Integration Tests
```bash
npm run test:local
npx vitest run test/context-regression.test.ts test/gate2.test.ts test/ai-sdlc-v2.test.ts test/builder.test.ts test/editor.test.ts test/opencode2.test.ts test/harness-executors.test.ts
```

### Level 4: Manual Validation
```bash
npm run azhi -- --help            # find the compile/validate command for a package
npm run azhi -- <compile-cmd> examples/context-review-revise
npm run demo                      # alpha demo must still pass
```
Install the example in a local server, run it with the scripted provider, open the run page, and confirm the context manifest lists one item per field, and that a node with a tiny `context_budget` shows a withheld note.

### Level 5: E2E / Browser Automation
```bash
npm run build:web
npx vitest run test/web.test.ts test/builder.test.ts test/editor.test.ts   # Playwright flows above
```
Confirm screenshots exist under `screenshots/` and there are no console errors in the Playwright logs.

### Level 6: Additional Validation
- `git diff --stat` shows no unrelated refactors; `grep -rn "ai-sdlc" src/` shows **no** new workflow-specific code (the genericity bar).
- Search the diff for `executor ===`/`'opencode'` literals outside `compile.ts`, `workspace.ts` adapters and run-plan (continuation must not leak executor logic into the runtime).

---

## ACCEPTANCE CRITERIA

Genericity and compatibility
- [ ] All four mechanisms are declared in `src/definition/schema.ts`; no profile, skill or example file is required for them to work.
- [ ] Any workflow can adopt each mechanism; the non-SDLC `context-review-revise` example uses all four.
- [ ] A workflow that uses none of the new fields compiles to a **byte-identical plan** (regression test over every example and fixture) and `test/gate2.test.ts` golden is unchanged.
- [ ] Bundle and `workspace.from` references appear in `dataDeps`, so taint analysis, type-checking, topological order and the run plan treat them as ordinary data edges (taint test).

Mechanism behaviour
- [ ] `contexts` + `context: [..]` work on agent, script, report and subworkflow nodes; collisions and shape errors are compile errors when static and `contract_violation` at run time otherwise; never a silent overwrite.
- [ ] With `context`, the manifest has one input item per field with its source; without it, the manifest is unchanged.
- [ ] `context_budget` (and the optional server default) is OFF unless set; when set, it applies to the model agent **and** OpenCode, Claude and Codex steps; oversized fields are replaced by `{note, artifact, shape}`; a still-over total fails with `budget_exceeded`; token figures are labelled `estimated`.
- [ ] `workspace.from` checks out the same base commit, applies the previous change from `files[]` (not `diff`), hard-fails on a SHA mismatch with an actionable message, and works in `read` and `write` mode; the change reaches the worker only through the artifact store (no file content in the Temporal payload).
- [ ] Continuation paths are validated (traversal, absolute, `.git`, symlinked parents, size limits) with tests for each.
- [ ] `workspace.from` on a non-OpenCode executor is a compile error naming the executor.
- [ ] `handoff` adds an optional string to the node's submit schema and downstream ref types; it is taint-equivalent to the node's other output; a user-declared `handoff` or a non-object schema is a compile error.

Authoring surfaces
- [ ] "Build with chat": `skill.md` documents all four with when-to-use rules; a scripted draft-review-revise proposal compiles; the draft panel shows a "Shared context" fact and per-step lines; a builder test proves it.
- [ ] "Build with chat" **edits**: changing an existing workflow keeps its `contexts:` block and `context:` lists (the skill says so; `test/builder-edit.test.ts` proves a patch preserves them and that dropping the block is rejected with `unknown_context`).
- [ ] Visual editor: Contexts section, step pickers (bundles, budget, handoff, continue-from), and rename rewrites refs inside `contexts:` and `workspace.from`.
- [ ] YAML upload: schema and compiler diagnostics are specific and quote the node and path.

Quality
- [ ] `npm run typecheck`, `npm run test:local` and `npm run build:web` pass.
- [ ] `ai-sdlc-v2` adopts bundles (and continuation if the selector issue in task 21 resolves) with an unchanged compiled graph and passing tests; its CHANGELOG is updated.
- [ ] `docs/context-sharing.md` exists and states the limits honestly (withheld fields are unreadable by the agent; OpenCode-only continuation; server-level budget default).
- [ ] No new `ai-sdlc`-specific code in `src/`.
- [ ] Conventional commits on `dev`; no PR opened unless asked.

---

## COMPLETION CHECKLIST

- [ ] Baseline plan snapshots taken before any code change
- [ ] All tasks completed in order, each task's VALIDATE passed
- [ ] Full suite passes (`npm run test:local`)
- [ ] No type errors (`npm run typecheck`), web builds (`npm run build:web`)
- [ ] Playwright E2E flows passed, screenshots saved under `screenshots/`
- [ ] Manual validation (Level 4) done on the example
- [ ] All acceptance criteria above checked
- [ ] Diff reviewed adversarially: taint paths, sandbox purity of `values.ts`, path safety in `cloneWorkspace`, no content in Temporal payloads

---

## NOTES

**Revision 2 (re-validation against `origin/dev` @ `2d99c8e`)**
- Unchanged and still valid: every compiler, definition, runtime, agents, worker, API, plan and config reference (Tasks 1-14). Only `cloneWorkspace` gained a 2-line git stall setting; line numbers there moved by about 2.
- Changed: the builder can now edit existing workflows by patch (`new_version_of` + changed `files` + `remove`), so a patch that rewrites `workflow.yaml` could drop `contexts:`. Added the skill rule (Task 15), a test (Task 24) and the acceptance criterion; the compiler's `unknown_context` error is the backstop, so no change to `applyChange` is needed.
- Corrected a wrong assumption in the first draft: the Builder page has no per-step "model/limits line". Task 17 now adds a "Shared context" fact and per-step lines to `DraftPanel`, computed in the browser from `p.nodes[].def` and `workflow.yaml`, with no API change.
- `skill.md` grew by about 65 lines (new-vs-existing question, `read_workflow`, MCP proposals). The whole skill is sent every turn, so the new section must stay short.
- `web/src/styles.css`, `WorkflowCanvas.tsx`, `Examples.tsx` and `Run.tsx` were restyled/rewritten: reuse existing classes and do not touch canvas wiring. `Examples.tsx` lists examples from the API, so `context-review-revise` appears without a code change (confirm visually in Level 5).
- The regression snapshot (Validation, "Before touching code") must be taken from the **current** `dev` HEAD, because `examples/pr-review` and `examples/sdlc-universal` changed in the same range.

**Corrections to the earlier brainstorm (found by reading the code)**
1. `harnessPrepare` calls `agentBegin`, so the input budget in `agentBegin` covers every executor; the earlier claim that harnesses build their own prompts was wrong.
2. Continuation applies `workspace.files[]`, not `git apply` of `diff` (the diff can be truncated).
3. Only OpenCode supports `workspace` today (two adapters, one `cloneWorkspace`), so "a continuation test per executor" means OpenCode v1 + v2 wiring plus the shared unit test.
4. Large changes must go through the artifact store: Temporal's blob limit is 2 MB and `files` can reach ~1 MB.
5. The editor's `renameStep` only rewrites inside `nodes`; `contexts:` needs explicit handling.

**Risks**
- *Taint laundering* is the main risk; mitigated by routing every new reference through `nodeValues` -> `dataDeps`. The taint test is the gate - do not skip it.
- *Sandbox purity*: `resolveNodeInput` runs in the Temporal workflow sandbox (no Node imports, no randomness, no clocks).
- *`ai-sdlc-v2` fix round*: its fix nodes consume `change_N`, a script that selects among three build variants, not a write-mode agent. Decide in task 21 whether to widen the `workspace.from` rule to pure selector scripts or leave the fix round on the diff-in-prompt path in v1. Recommendation: leave it for v1 and ship bundles only, unless the widening is a few lines.
- *Withheld fields* are unreadable by the agent (no artifact-read tool). If that proves too blunt, a follow-up could add a read-only artifact tool; out of scope here.
- *Moved base branch*: continuation hard-fails if the ref moved between the producing and consuming step; the documented fix is to pin `ref` to `base_sha`.

**Follow-ups (not in this plan)**
- A DB-backed, UI-editable workspace-wide `context_budget` default (Governance › Usage and limits) instead of env settings.
- Workspace support for the Claude and Codex harnesses (then continuation extends to them).
- A `first_of(...)` CEL helper to replace selector scripts like `pick_change.py`.

**Confidence for one-pass success: 7/10** (up from 6.5 after re-validation). The compiler, runtime and tests are well specified and unchanged by recent work; the builder tasks now rest on code I read in full (`builder.ts`, `skill.md`, `Builder.tsx`, `builder-edit.test.ts`). The riskiest parts remain the sandboxed runtime merge, the worker path-safety and continuation wiring across two adapters (real OpenCode is only needed for optional manual checks), and the editor work, which I read at the structural level and did not run.
