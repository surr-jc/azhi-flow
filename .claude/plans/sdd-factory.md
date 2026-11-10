# Feature: sdd-factory (spec-driven AI SDLC factory)

The following plan should be complete, but validate documentation, codebase patterns and task sanity before you
start implementing. Pay special attention to the names of existing node ids, schemas and scripts: copy from the
named files, do not retype them.

## Feature Description

One run that takes a goal or ticket for a greenfield or brownfield repository and carries it to a stack of reviewed,
signed-off pull requests. It asks questions with recommendations, writes a release plan (PRD), gets it approved,
splits it into Epics and Stories, asks whether to continue supervised or unattended, then delivers each Story in
dependency order as its own child run: an OpenSpec change, build and test, a pushed branch stacked on the previous
Story, a pull request into the base branch, a `pr-review` child run on that pull request, one fix round and a
sign-off. It ends with a release check against the PRD and a Slack summary. Nothing merges.

## User Story

As a tech lead running Azhi Flow
I want to hand one goal, a repository and a base branch to a factory run
So that I get an approved plan, ordered tickets and a stack of reviewed pull requests, with or without approving every step

## Problem Statement

The pieces exist but only as separate runs: `ai-sdlc-factory-plan` plans and splits, `ai-sdlc-factory` delivers one
ticket per scheduled lap, `pr-review` and `ai-sdlc-factory-verify` are started by hand. Nothing delivers the tickets
of one plan in order in one run, nothing stacks branches (so ticket 2 cannot see ticket 1's code until a person
merges), and no workflow has an unattended mode.

## Solution Statement

Two new example packages and two small additions to existing ones:

- `examples/sdd-story` (new, published as `sdd-story`): one Story to a signed-off pull request. Based on
  `openspec-flow`, with a `stack_on` input (the branch to cut from, separate from the PR target), a `mode` input
  (`supervised` | `auto`), the `pr-review` child, one fix round and a sign-off.
- `examples/sdd-factory` (new): the orchestrator. Copies the brainstorm and PRD steps of `ai-sdlc-factory-plan`,
  runs the published splitter once per epic in a loop, asks the autonomy question, then loops over Stories calling
  `sdd-story`, then `ai-sdlc-factory-verify`, then a summary.
- `examples/pr-review`: an optional `diff_base` input, so a stacked pull request is reviewed against the previous
  Story's head and not against the base branch.
- `examples/ai-sdlc-factory-verify`: an optional `propose_fix` input (default true), so the factory can ask for the
  check without the fix-ticket approval.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: High
**Primary Systems Affected**: `examples/` (two new packages, two changed), `test/`, `docs/`, `web/src/pages/Examples.tsx`. No engine change is planned; Phase 0 confirms that.
**Dependencies**: none new. Jira (Phase 5) needs `uv` on the worker (`uvx mcp-atlassian`), which this Windows host does not have.

## Decisions already made with the user (do not re-ask)

| Topic | Decision |
|---|---|
| Inputs | Always `repo`, `base_branch`, tracker `github` / `jira` / `files` ("ignore"), and a ticket and/or a goal |
| Spec | Release PRD once, plus an in-repo OpenSpec change per Story |
| Hierarchy | Epic > Story; one child run, branch and PR per Story; tasks are the OpenSpec `tasks.md` checklist |
| Ordering | Stacked branches: Story N is cut from Story N-1's branch; every PR targets `base_branch` |
| Autonomy | Plan and ticket creation always need a person. In `auto`, every per-Story gate takes the agent's recommendation and posts it to Slack |
| Review | `pr-review` as a child on the opened PR; confirmed findings get one fix round, tests rerun |
| Sign-off | Tests passed, review approved, code matches its OpenSpec. `supervised`: a person approves with those shown. `auto`: rules decide |
| Failure | Stop the loop and notify; later Stories untouched |
| Greenfield | An empty repository the user created, with one commit; the first Story is a runnable scaffold with tests and CI |
| Release check | `ai-sdlc-factory-verify` on the top branch of the stack, result in the summary, no fix tickets |
| Slack | Auto-mode decisions, each Story finished, failure, final summary (approvals already post there) |

---

## CONTEXT REFERENCES

### Relevant Codebase Files: READ THESE BEFORE IMPLEMENTING

- `docs/loops-and-subworkflows.md` - Why: the rules for a loop `body` and a `subworkflow` step; every limit below comes from it.
- `src/compiler/loops.ts` (lines 29-34, 203-244, 335-440) - Why: `BODY_TYPES` allows `subworkflow`, `script`, `condition`, `report`; not `approval`, `notify` or write tools. Caps: 20 rounds, 5 when the body has an agent. `state.<key>` and `iteration` are rewritten per round.
- `src/compiler/taint.ts` (lines 14-19, 79-87, 106-141) - Why: a write reached by tainted output needs an approval on the path OR a CEL `guard` on the write. So routing around an approval is legal only when every write keeps its guard.
- `src/compiler/plan.ts` (lines 163-175) and `src/runtime/workflow.ts` (line 559) - Why: a `subworkflow` step defaults to a 1 hour timeout and the child run is given that as its execution timeout. A Story with approvals needs an explicit `timeout`.
- `src/gateway/tools/github.ts` (lines 520-576) - Why: `github.push-branch` commits onto any `base_sha` in the repository, and re-pushing an `azhi/` branch whose last commit is Azhi's force-updates it. That is what makes stacking and the fix-round re-push work.
- `examples/openspec-flow/workflow.yaml` (whole file) - Why: the base for `sdd-story`. Note the hard-coded test command at line 327, the two approvals (278, 391), `push_branch` (477) and `open_pr` (497) with their guards.
- `examples/openspec-flow/azhi.config.yaml`, `profiles/`, `harness/`, `schemas/`, `scripts/`, `templates/` - Why: copied into `sdd-story`.
- `examples/sdlc-universal/scripts/build_gate_commands.mjs`, `gate.js`, and the nodes in `workflow.yaml` that use them - Why: how a delivery detects the repository's own test command; `sdd-story` must use this, not openspec-flow's hard-coded command.
- `examples/ai-sdlc-factory-plan/workflow.yaml` (lines 44-166) - Why: intake, `brief`, `brainstorm`, `brainstorm_review`, `plan_release`, `prd`, `prd_review`, `epics`; copied into `sdd-factory`.
- `examples/ai-sdlc-factory/workflow.yaml` (lines 117-137) and `scripts/outcome.py` - Why: the pattern for a child with `on_failure: continue` and a script that reads `{state, error, nodes}` and fails closed.
- `examples/issue-splitter/workflow.yaml` (lines 182-336) and `schemas/outcome.json` - Why: it already creates a parent issue (the Epic) and up to six sub-issues with `parent` (the Stories); `nodes.outcome.output` is `{parent_number, created: [{number, title, url, linked}]}`.
- `examples/pr-review/workflow.yaml` (lines 18-26, 46-61, 107-161) - Why: inputs `repo`, `pr`, `post`, `offer_merge`; the shared `&checkout` uses `base_ref: nodes.pr.output.base_sha`; the verdict and findings are in `nodes.summarize.output`.
- `examples/ai-sdlc-factory-verify/workflow.yaml` - Why: inputs `repo`, `staging_branch`, `journeys`; has a fix-ticket approval to switch off.
- `test/ai-sdlc-factory.test.ts` (lines 1-60) - Why: the compile test ("compiles, and every write is behind a gate") and the Python script runner to mirror.
- `test/ai-sdlc-factory-plan-e2e.test.ts` (lines 1-110) - Why: an engine test with scripted models and stand-in child workflows; mirror for the factory's loop.
- `test/loop-subworkflow.test.ts`, `test/loop-rounds.test.ts`, `test/loop-expansion.test.ts` - Why: existing loop and child-run tests; Phase 0 adds the missing case to them.
- `test/pr-review-base.test.ts` - Why: pattern for testing the `diff_base` input.
- `test/context-regression.test.ts` and `test/golden/context-regression/` - Why: every example has a golden; read how one is created before adding packages.
- `.gitattributes` - Why: packages are signed by their bytes; new packages need LF lines pinned.
- `web/src/pages/Examples.tsx` - Why: the list of installable examples in the UI.
- `docs/ai-sdlc-factory.md` - Why: the doc style to match for `docs/sdd-factory.md`.

### New Files to Create

- `examples/sdd-story/` - `workflow.yaml`, `azhi.config.yaml`, `README.md`, `profiles/`, `harness/`, `schemas/`, `scripts/`, `templates/`
  - new in it: `scripts/decide.py`, `scripts/review_outcome.py`, `scripts/signoff.py`, `scripts/result.py`, `harness/commands/fix-findings.md`, `schemas/{decision,review_outcome,signoff,result}.json`
- `examples/sdd-factory/` - `workflow.yaml`, `azhi.config.yaml`, `README.md`, `profiles/`, `harness/`, `schemas/`, `scripts/`, `templates/`
  - new in it: `scripts/order.py`, `scripts/story_outcome.py`, `scripts/journeys.py`, `schemas/{order,story_outcome}.json`, `templates/summary.md`, `harness/skills/greenfield-brainstorm/SKILL.md` (Phase 4)
- `test/sdd-story.test.ts`, `test/sdd-factory.test.ts`, `test/sdd-factory-e2e.test.ts`
- `test/fixtures/` stand-in child workflows for the e2e test, next to the ones the plan e2e test uses
- `docs/sdd-factory.md`

### Patterns to Follow

**A write always carries a guard pinned to inputs** (`examples/openspec-flow/workflow.yaml:496`):

```yaml
guard: args.repo == inputs.repo && args.branch == 'azhi/' + nodes.intake.output.key
```

**A child that may fail, read by a script that fails closed** (`examples/ai-sdlc-factory/workflow.yaml:117`):

```yaml
- id: deliver
  type: subworkflow
  workflow: sdlc-universal
  on_failure: continue
  input: {source: {ref: inputs.source}, ticket: {ref: nodes.pick.output.ticket.ref}, repo: {ref: inputs.repo}}
- id: outcome
  type: script
  runtime: python
  entrypoint: scripts/outcome.py
  input: {map: "{'child': nodes.deliver.output}"}
```

**A join after two routes**: `merge: any` plus `depends_on: [a, b]`, and `has(nodes.a) ? ... : ...` in the input (`examples/openspec-flow/workflow.yaml:230-241`).

**Scripts**: Python standard library only, read JSON on stdin, write JSON on stdout, no file paths, no processes, no platform checks. Unknown values are `null` or `unavailable`, never guessed. A value that cannot be read fails closed (does less).

**Unattended gate (new pattern, justified)**: a `condition` on `inputs.mode` routes to the `approval` (supervised) or to a `decide` script (auto); a `merge: any` step joins them and exposes one `decisions` object. Legal because taint accepts a guard as the gate (`taint.ts:81-87`); every write after the join keeps its guard.

**Naming**: node ids `snake_case`; package and workflow ids `kebab-case`; branches `azhi/<ticket key>`; conventional commits.

---

## IMPLEMENTATION PLAN

### Phase 0: Prove the engine does what the design needs (tests only)

Three facts were read from code, not run. Each gets a test before any package is written. If one fails, stop and
report: the fix is an engine change outside this plan.

1. A loop `body` holding a `subworkflow` step, with `state` fed from the child's output through a script, runs N rounds in order and stops on an exit rule.
2. A `subworkflow` step with `timeout: 96h` waits past one hour, and the child's approval can be answered.
3. A workflow that routes around an `approval` with a `condition` compiles with every write gated by its guard, and the run plan shows the gate as `guard`.

### Phase 1: `sdd-story`, GitHub, supervised

The Story child, usable on its own from the UI. Ends with a branch stacked on `stack_on`, a PR into `base_branch`,
a review on it, at most one fix round and a person's sign-off.

### Phase 2: `sdd-factory`, GitHub, supervised

The orchestrator: brainstorm, PRD, approval, split per epic, autonomy question (answer recorded, `supervised`
enforced until Phase 3), Story loop, release check, summary.

### Phase 3: `auto` mode

The unattended gates in `sdd-story`, the Slack post for each decision taken, and the factory passing the chosen mode.

### Phase 4: tracker `files` and greenfield

The breakdown committed as files when no tracker is used; the empty-repository brainstorm and scaffold-first rule.

### Phase 5: Jira

Jira intake in `sdd-story`, `issue-splitter-jira` in the split loop, a `jira.transition-issue` tool. Blocked on `uv`
on the worker; not startable on this host.

---

## STEP-BY-STEP TASKS

Execute in order. Each task ends with its validation.

### Phase 0

#### ADD case to `test/loop-rounds.test.ts` (or `loop-subworkflow.test.ts`, whichever holds body tests)

- **IMPLEMENT**: a fixture workflow: `initial: {prev: 'base'}`, body `[child (subworkflow: doubler, on_failure: continue), outcome (script)]`, `exit: [{when: "nodes.outcome.output.status != 'ok'", outcome: stop}, {when: "iteration >= 3", outcome: done}]`, `next: {prev: {cel: nodes.outcome.output.value}}`. Assert three child runs, in order, each receiving the previous round's value; then a variant where round 2's child fails and the loop ends `stop` with round 3 never started.
- **PATTERN**: `test/loop-subworkflow.test.ts:135-235` (publishing a child, `on_failure: continue`), `examples/caller`, `examples/doubler`
- **GOTCHA**: `iteration` in `exit` is the number of rounds completed; in the body it is the 0-based round.
- **VALIDATE**: `npx vitest run test/loop-rounds.test.ts test/loop-subworkflow.test.ts`

#### ADD case: long-lived child

- **IMPLEMENT**: a child with one `approval`; the parent's `subworkflow` step sets `timeout: 96h`. Assert the compiled plan's `timeoutMs` for the step is 96h, and that answering the approval lets the parent finish. Also assert what happens with no `timeout` (1h default) so the behaviour is recorded.
- **PATTERN**: `src/compiler/plan.ts:163-175`, `src/runtime/workflow.ts:559`
- **GOTCHA**: `examples/ai-sdlc-factory` sets no timeout on `deliver`. If the test shows a 1h child limit, report it to the user as a separate fix; do not change that example here.
- **VALIDATE**: `npx vitest run test/loop-subworkflow.test.ts`

#### ADD case: routed-around approval stays gated

- **IMPLEMENT**: compile a fixture: tainted agent -> `condition` on `inputs.mode` -> `approval` | `decide` script -> `merge: any` join -> write tool with a guard. Assert no `tainted_write_ungated`, and a second fixture without the guard fails with it.
- **PATTERN**: the gate assertion in `test/ai-sdlc-factory.test.ts` ("every write is behind a gate")
- **VALIDATE**: `npx vitest run test/loop-subworkflow.test.ts`

### Phase 1

#### UPDATE `examples/pr-review/workflow.yaml` and `azhi.config.yaml`

- **IMPLEMENT**: optional input `diff_base` (40 or 64 hex chars, or empty). The `&checkout` `base_ref` becomes `has(inputs.diff_base) && inputs.diff_base != '' ? inputs.diff_base : nodes.pr.output.base_sha`. Pass the same value to the reviewers' input so they know which files are in scope.
- **PATTERN**: `examples/pr-review/workflow.yaml:51-58`; `test/pr-review-base.test.ts`
- **GOTCHA**: `nodes.pr.output` lists every file of the PR, which on a stacked PR includes earlier Stories. Check what `github.get-pull-request` returns and whether the reviewers take the file list from it or from the checkout diff; if from it, filter in a script. The context-regression golden for `pr-review` changes: regenerate it the way `test/context-regression.test.ts` documents and review the diff.
- **VALIDATE**: `npx vitest run test/pr-review.test.ts test/pr-review-base.test.ts test/context-regression.test.ts`

#### CREATE `examples/sdd-story/` by copying `examples/openspec-flow/`

- **IMPLEMENT**: copy the package; set `id: sdd-story`; add `.gitattributes` line `examples/sdd-story/** text eol=lf`. Inputs: `source` (`github` for now), `ticket`, `repo`, `base_branch` (PR target, required), `stack_on` (branch to cut from; optional, pattern `^[A-Za-z0-9._/-]{1,200}$`; empty means `base_branch`), `mode` (`supervised` | `auto`, default `supervised`).
- **GOTCHA**: keep agents, skills and schemas byte-identical to `openspec-flow` where unchanged, so later updates can be compared.
- **VALIDATE**: `npx vitest run test/sdd-story.test.ts` (created in the next task; compile + gates)

#### CREATE `test/sdd-story.test.ts`

- **IMPLEMENT**: compile the package with its tools; assert every write has a gate; run each new script on fixtures.
- **PATTERN**: `test/ai-sdlc-factory.test.ts:1-60`, `test/openspec-flow.test.ts`, `test/openspec-flow-scripts.test.ts`
- **VALIDATE**: `npx vitest run test/sdd-story.test.ts`

#### UPDATE `examples/sdd-story/workflow.yaml`: cut from `stack_on`, target `base_branch`

- **IMPLEMENT**: every `workspace.ref` becomes `'refs/heads/' + (has(inputs.stack_on) && inputs.stack_on != '' ? inputs.stack_on : inputs.base_branch)`. `open_pr.base` stays `inputs.base_branch`. `push_branch.base_sha` stays `nodes.archive.output.workspace.base_sha` (it is the head of whatever ref was checked out).
- **GOTCHA**: the read token and the tool's `repos` list must allow reading `azhi/` branches; confirm in `azhi.config.yaml`.
- **VALIDATE**: a test asserting the compiled `ref` and `base` expressions; `npx vitest run test/sdd-story.test.ts`

#### UPDATE `examples/sdd-story/workflow.yaml`: the repository's own tests

- **IMPLEMENT**: replace the hard-coded `workspace.test.command` at the `apply` step with the test gate `sdlc-universal` uses (copy its scripts and the nodes that build the command).
- **PATTERN**: `examples/sdlc-universal/scripts/build_gate_commands.mjs`, `gate.js`, and their nodes in `examples/sdlc-universal/workflow.yaml`
- **GOTCHA**: a repository with no detectable test command must end as "sent back", never as passed.
- **VALIDATE**: `npx vitest run test/sdd-story.test.ts`

#### UPDATE `examples/sdd-story/workflow.yaml`: push before sign-off, then review

- **IMPLEMENT**: remove `release_approval`. After `release_gate` says `ship`: `archive` -> `archive_check` -> `push_branch` -> `open_pr` (draft when the verifier found a CRITICAL issue or reported prompt injection) -> `review` (`type: subworkflow`, `workflow: pr-review`, `on_failure: continue`, `timeout: 2h`, input `{repo, pr: nodes.open_pr.output.number, post: true, offer_merge: false, diff_base: nodes.archive.output.workspace.base_sha}`) -> `review_outcome` (script).
- **IMPLEMENT** `scripts/review_outcome.py`: from the child's `{state, nodes.summarize}` produce `{status: approved | findings | unavailable, fix_now: [...], summary}`. A child that did not succeed, or a verdict it cannot read, is `unavailable`.
- **GOTCHA**: `offer_merge` must stay false: nothing merges. A subworkflow output is tainted; nothing from it may reach a write except through a guard. Check the exact field names in `examples/pr-review/schemas/review.json` and `open_pr`'s output schema.
- **VALIDATE**: script fixtures in `test/sdd-story.test.ts`; `npx vitest run test/sdd-story.test.ts`

#### ADD fix round to `examples/sdd-story`

- **IMPLEMENT**: `review_gate` (condition on `review_outcome.status`): `approved` -> sign-off; `findings` -> `fix` agent (`engineer@1`, new command `harness/commands/fix-findings.md`, `workspace.from: nodes.archive.output.workspace`, same test gate) -> `fix_check` (tests passed, and the archive postconditions still hold) -> `push_fix` (`github.push-branch`, same branch, same `base_sha`, guard as `push_branch`) -> sign-off; `unavailable` -> send back.
- **PATTERN**: `revise` / `check_2` in `examples/openspec-flow/workflow.yaml:161-213` for a one-round fix; `src/gateway/tools/github.ts:550-575` for the re-push
- **GOTCHA**: one round only, no second review (cost); the sign-off payload must say the fix was not re-reviewed. The re-push replaces the branch's single commit, so the fix workspace must hold the whole change.
- **VALIDATE**: `npx vitest run test/sdd-story.test.ts`

#### ADD sign-off and result to `examples/sdd-story`

- **IMPLEMENT**: `signoff` (approval, supervised): payload has the PR url, test status, review verdict and remaining findings, verifier summary. Then `label_ticket` (`github.label-issue`, label from config `signed_off_label`, guard pinned to the ticket), `story_notify` (Slack), and `result` (script, `merge: any` over every end route) producing `{status: signed_off | sent_back | rejected, reason, branch, head_sha, pr_number, pr_url}`.
- **GOTCHA**: `result` must exist on every route, including the send-backs copied from `openspec-flow`, because the parent reads `nodes.<step>.output.nodes.result`. A rejected approval fails the run today: decide with a test whether `result` is reachable then, and rely on `on_failure: continue` in the parent if not.
- **VALIDATE**: `npx vitest run test/sdd-story.test.ts`

### Phase 2

#### UPDATE `examples/ai-sdlc-factory-verify`

- **IMPLEMENT**: optional input `propose_fix` (boolean, default true); when false the route to the fix-ticket approval is skipped.
- **VALIDATE**: `npx vitest run test/ai-sdlc-factory.test.ts test/ai-sdlc-factory-verify-e2e.test.ts test/context-regression.test.ts`

#### CREATE `examples/sdd-factory/` from `examples/ai-sdlc-factory-plan/`

- **IMPLEMENT**: copy the package; `id: sdd-factory`; keep nodes `source_gate` through `epics` unchanged; inputs as there, with `source` renamed in meaning only (values `github`, later `jira`, `files`). Add the `.gitattributes` line.
- **VALIDATE**: `npx vitest run test/sdd-factory.test.ts` (compile + gates, mirrored from `test/ai-sdlc-factory.test.ts`)

#### REPLACE the three hand-written epic slots with a loop

- **IMPLEMENT**: `split_epics`: `type: loop`, `max_iterations: 3`, `on_max: continue`, body `[split (subworkflow: issue-splitter, on_failure: continue, timeout: 96h, input text = nodes.epics.output.epics[iteration].text), split_outcome (script)]`, exit `done` when `iteration >= nodes.epics.output.count`, `stop` when a split did not succeed. Guard the loop with a `condition` for `count == 0`.
- **PATTERN**: `examples/ai-sdlc-factory-plan/workflow.yaml:168-193`; loop body syntax in `docs/loops-and-subworkflows.md`
- **GOTCHA**: the splitter has its own approval per epic; that is the ticket-creation approval the user wants kept in both modes.
- **VALIDATE**: `npx vitest run test/sdd-factory.test.ts`

#### CREATE `examples/sdd-factory/scripts/order.py`

- **IMPLEMENT**: from `nodes.split_epics.output.rounds`, list the Stories in delivery order: epics in plan order, Stories in creation order inside an epic. Output `{count, stories: [{ref, number, title, epic}], too_many}`. More than 20 Stories sets `too_many` and the run stops with a message before any delivery.
- **GOTCHA**: the input is tainted child output. Build `ref` only from `inputs.repo` and an integer `number`; never pass a title into a ref. Anything unreadable gives `count: 0` and a reason.
- **VALIDATE**: fixtures in `test/sdd-factory.test.ts`

#### ADD the autonomy question

- **IMPLEMENT**: `autonomy` (approval, role author): message lists the Stories in order; `decision_schema: {mode: {enum: [supervised, auto]}}`, required. Until Phase 3, a `condition` sends `auto` to a report saying it is not available yet and continues supervised.
- **PATTERN**: `brainstorm_review` in `examples/ai-sdlc-factory-plan/workflow.yaml:108-122`
- **VALIDATE**: `npx vitest run test/sdd-factory.test.ts`

#### ADD the Story loop

- **IMPLEMENT**:

```yaml
- id: deliver_stories
  type: loop
  max_iterations: 20
  on_max: fail
  initial: {stack_on: {ref: inputs.base_branch}}
  body:
    - id: story
      type: subworkflow
      workflow: sdd-story
      on_failure: continue
      timeout: 96h
      input:
        source: {ref: inputs.source}
        ticket: {cel: "nodes.order.output.stories[iteration].ref"}
        repo: {ref: inputs.repo}
        base_branch: {ref: inputs.base_branch}
        stack_on: {ref: state.stack_on}
        mode: {ref: nodes.mode.output.mode}
    - id: story_outcome
      type: script
      runtime: python
      entrypoint: scripts/story_outcome.py
      input: {map: "{'child': nodes.story.output}"}
      output_schema: schemas/story_outcome.json
  exit:
    - {when: "nodes.story_outcome.output.status != 'signed_off'", outcome: stop, reason: A Story was not signed off}
    - {when: "iteration >= nodes.order.output.count", outcome: done, reason: Every Story is signed off}
  next:
    stack_on: {cel: nodes.story_outcome.output.branch}
```

- **IMPLEMENT** `scripts/story_outcome.py`: read `child.state` and `child.nodes.result`; output `{status, reason, branch, pr_url}`. `branch` must match `^azhi/[A-Za-z0-9._/-]+$`, else status is `sent_back`.
- **PATTERN**: `examples/ai-sdlc-factory/scripts/outcome.py`
- **GOTCHA**: 20 rounds of 2 steps plus a gate puts about 60 steps in the run plan; check the run page still reads well. Nesting is factory > story > pr-review, three of the four levels allowed.
- **VALIDATE**: `npx vitest run test/sdd-factory.test.ts`

#### ADD release check, stop notice and summary

- **IMPLEMENT**: after the loop, a `condition` on `nodes.deliver_stories.output.outcome`. `done`: `journeys` (script: PRD journeys and invariants as text) -> `release_check` (`subworkflow: ai-sdlc-factory-verify`, `on_failure: continue`, input `staging_branch` = the last round's branch, `propose_fix: false`). Both routes join in `summary` (report: Stories signed off, the PR stack in merge order, the Story that stopped it and why, the release verdict or `unavailable`) and `summary_notify` (Slack, guard on the channel).
- **GOTCHA**: later steps read only `nodes.deliver_stories.output` (`outcome`, `reason`, `last`, `rounds`), never a round's step.
- **VALIDATE**: `npx vitest run test/sdd-factory.test.ts`

#### CREATE `test/sdd-factory-e2e.test.ts`

- **IMPLEMENT**: scripted models, stand-in `issue-splitter`, `sdd-story` and `ai-sdlc-factory-verify` children. Cases: three Stories all signed off (assert each `stack_on` is the previous branch and the first is `base_branch`); Story 2 sent back (assert Story 3 never starts and the summary names Story 2); zero Stories; 21 Stories.
- **PATTERN**: `test/ai-sdlc-factory-plan-e2e.test.ts`
- **VALIDATE**: `npm run test:local -- test/sdd-factory-e2e.test.ts`

#### ADD docs, UI entry and goldens

- **IMPLEMENT**: `docs/sdd-factory.md` (style of `docs/ai-sdlc-factory.md`: table, flow, install, what it does not do); entries in `web/src/pages/Examples.tsx`; READMEs; context-regression goldens for both packages.
- **VALIDATE**: `npm run typecheck`, `npm run build:web`, `npx vitest run test/context-regression.test.ts`

### Phase 3

#### ADD unattended gates to `examples/sdd-story`

- **IMPLEMENT**: at `proposal_approval` and `signoff`: `mode_gate` (condition on `inputs.mode`) -> approval | `decide` / `signoff_rules` script -> `merge: any` join exposing one object. `scripts/decide.py` answers each open question with the author's recommended default and refuses (`status: needs_person`) when the spec reviewer did not approve, reported prompt injection, or a question has no recommendation. `scripts/signoff.py` signs off only when tests passed, the review is `approved` or its fix round passed, and the verifier has no CRITICAL issue.
- **IMPLEMENT**: `needs_person` in auto mode falls back to the approval, so the run asks instead of guessing. A `decision_notify` (Slack) posts each question, the answer taken and the reason.
- **GOTCHA**: the spec author's schema must carry a recommendation per open question: check `schemas/proposal.json` and the `spec-author` prompt, and add the field if missing. Slack text is built from author-written fields only where possible; ticket text is data.
- **VALIDATE**: script fixtures plus a compile test of both routes; `npx vitest run test/sdd-story.test.ts`

#### UPDATE `examples/sdd-factory`: pass the chosen mode

- **IMPLEMENT**: remove the "not available yet" route; `mode` reads the approval.
- **VALIDATE**: e2e case in `test/sdd-factory-e2e.test.ts` asserting the child receives `auto`

### Phase 4

- **ADD** tracker `files`: a `breakdown` agent (copy of `scope-analyst`, schema with epics, Stories and dependencies) and, after its approval, the breakdown written into the first Story's change as `openspec/` files. `sdd-story` gets `source: files` with a `story` text input instead of a ticket. Validate with compile tests and an e2e case.
- **ADD** greenfield: a script that reads `github.repo-files` and marks the repository empty (one commit, no source files); `harness/skills/greenfield-brainstorm` for stack, architecture and scaffold questions; the planner input `first_story: scaffold` so Story 1 is a runnable scaffold with tests and CI. Validate with a scripted-model e2e case.
- **GOTCHA**: `github.push-branch` needs a `base_sha`, so a repository with no commit cannot be used; say so in the brainstorm stop message.

### Phase 5 (blocked on `uv`)

- **ADD** Jira intake to `sdd-story` (mirror `sdlc-universal`'s `jira_issue` and `ticket.normalize` branch), `issue-splitter-jira` in the split loop, `jira.transition-issue@1` in `azhi.config.yaml` for sign-off. Validate with `test/issue-splitter-jira.test.ts`-style fixtures, then on a throwaway Jira project.

---

## TESTING STRATEGY

- **Unit**: every new script on fixtures for the normal case and each fail-closed case (unreadable child, bad branch name, missing recommendation), run through the Python finder in `test/ai-sdlc-factory.test.ts`.
- **Compile**: each package compiles with its tools; every write has a gate; both mode routes compile.
- **Engine (e2e)**: scripted models and stand-in children under `npm run test:local`; needs Temporal, and is skipped when `temporalAvailable()` is false, so say so in the report when it did not run.
- **Edge cases**: zero Stories; more than 20; a child that fails, expires or is rejected; a Story with no test command; a review child that fails; `stack_on` empty; an auto-mode question without a recommendation; resume after a crash between `push_branch` and `open_pr` (the ledger must return the same branch and PR).
- **Browser**: after `npm run build:web`, open the Examples page and a factory run page in the preview; check the loop rounds and child links render. `agent-browser` is not among this repository's skills, so use the built-in preview.

## VALIDATION COMMANDS

```bash
npm run typecheck
```

```bash
npx vitest run test/sdd-story.test.ts test/sdd-factory.test.ts test/loop-rounds.test.ts test/loop-subworkflow.test.ts test/pr-review.test.ts test/pr-review-base.test.ts test/context-regression.test.ts
```

```bash
npm run test:local
```

```bash
npm run build:web
```

Manual, on a throwaway GitHub repository with a Slack channel: install and publish `issue-splitter`, `pr-review`,
`ai-sdlc-factory-verify`, `sdd-story`, then `sdd-factory` (`azhi example install <name> --repo OWNER/REPO --set slack_channel=...`),
run the factory with a two-Story goal, and check the second PR's branch contains the first's commit.

## ACCEPTANCE CRITERIA

- [ ] The run asks for repository, base branch and tracker, and every branch is cut from the base branch or the previous Story's branch; every PR targets the base branch
- [ ] Questions reach a person with a recommendation each, in mission control and Slack
- [ ] No ticket is created before the plan approval and the splitter's approval, in either mode
- [ ] Stories are delivered in order, one child run each, visible under the loop on the run page
- [ ] Each Story has an OpenSpec change, a test run, a `pr-review` review on its PR, at most one fix round and a recorded sign-off
- [ ] A Story that is not signed off stops the loop, posts to Slack, and no later Story starts
- [ ] In `auto`, no approval is asked after the autonomy question unless a rule returns `needs_person`; each decision taken is posted
- [ ] The summary lists the PR stack in merge order and the release check result, or `unavailable`
- [ ] Nothing merges, closes or force-pushes a branch Azhi did not create; every write has a gate
- [ ] `npm run typecheck`, `npm run test:local` and `npm run build:web` pass

## COMPLETION CHECKLIST

- [ ] Phase 0 tests pass before any package is written
- [ ] Each task's validation passed when it was done
- [ ] Goldens regenerated and their diffs read
- [ ] Docs and the Examples page updated
- [ ] Live smoke on a throwaway repository done, or reported as not done

## NOTES

- **Confirmed by the user (2026-11-10)**: in supervised mode a Story's branch and PR are pushed after the spec approval and passing tests, before a person sees the code; the person signs off afterwards on the PR. Two approvals per Story (specs, sign-off); `release_approval` before the push is removed.
- **Stacked PRs show accumulated diffs** until earlier ones merge. `diff_base` keeps the review to the Story's own change, but the PR page on GitHub still shows everything.
- **The fix round is not re-reviewed.** A second `pr-review` would double the review cost; the sign-off shows that the fix was tested but not reviewed.
- **Limits**: 20 Stories per run (the loop cap), 3 epics, 6 Stories per epic (the splitter). A larger release is two runs.
- **Order between epics** follows plan order; the splitter only records dependencies inside an epic.
- **Not verified while planning**: nothing was run. The `auto` gate, the long child timeout and a subworkflow inside a loop body were read from the compiler and runtime, which is why Phase 0 exists. Jira could not be checked (the Atlassian connector timed out and the host has no `uv`).
- **Phase 0 done (2026-11-10)**: `test/loop-child-runs.test.ts`, 7 tests, passing against Temporal with PGlite. All three facts hold; no engine change is needed. The file is new, not added to `loop-rounds.test.ts` or `loop-subworkflow.test.ts`.
- **Phase 1 built and run on the engine (2026-11-10)**: `examples/sdd-story` compiles, every write is gated, scripts pass their fixtures (`test/sdd-story.test.ts`, 25 tests), and `test/sdd-story-e2e.test.ts` (10 tests, Temporal + PGlite, about two minutes) runs the package's own graph with every checkout agent replaced by a script and `pr-review` by a stand-in child, against a fake GitHub. Covered: first proposal passes (later steps still run), second round, both rounds fail, specs rejected, tests fail, the review child fails, one fix round re-pushed to the same branch (and its tests failing), sign-off approved and rejected. `result` is produced on every route, including rejected approvals. Putting the old `has(nodes.pass_2)` read back into one step makes the happy path fail. NOT covered: what the agents write, the real test gate against a repository, a real `pr-review` child (its input schema was not checked against the stand-in), `stack_on` reaching a real checkout.
- **Phase 1 differences from this plan**: the fix agent is profile `fixer@1` (a profile binds one command); `fix_done` and `signoff_state` scripts join the two routes into the sign-off; there is no `fix_check` of the archive after the fix, only its tests; `label_ticket` labels issue `number` in `inputs.repo` and does not check that the ticket is in that repository (safe while the tools allow one repository).
- **Phase 2 built and run on the engine (2026-11-10)**: `examples/sdd-factory` (26 authored steps, GitHub only) plus `propose_fix` on `ai-sdlc-factory-verify`. `test/sdd-factory.test.ts` (57 tests) and `test/sdd-factory-e2e.test.ts` (9 tests, about four minutes: scripted brainstorm and planner, stand-in `issue-splitter` with a real `github.create-issue` tool step on a fake GitHub, `sdd-story` and `ai-sdlc-factory-verify`). Covered: three Stories stacked in order then release check and summary; a Story sent back, a Story run that fails; release `failed` and `unavailable`; every epic dropped; more than 20 Stories; a failing splitter; autonomy rejected; brainstorm rejected (the summary still posts). NOT covered: real agents, a real `issue-splitter`/`sdd-story`/`pr-review` run, Slack and GitHub for real.
- **Engine trap 1 (found by the engine test)**: a loop gate is a `merge: any` step and the compiler counts every `nodes.x` its expression reads as a dependency. An exit rule that reads a step OUTSIDE the loop (e.g. `iteration >= nodes.epics.output.count`) makes the gate of a round that never started run, and the run fails with "No such key: <round step>". Fix used: the body step computes `last` from the outside count and the exit rule reads only `nodes.<body step>.output.last`. `test/sdd-factory.test.ts` asserts every gate depends only on its round's steps. Not fixed in the engine and not in the docs (`docs/loops-and-subworkflows.md` is silent on it).
- **Phase 3 built and run on the engine (2026-11-10)**: `auto` mode. The autonomy question offers `supervised` | `auto` (only exactly `auto` is unattended). In `sdd-story`, `specs_gate`/`signoff_gate` scripts route to `ask` (the existing approval) or `auto` (`specs_auto`/`signoff_auto` + a Slack notify), joined by `merge: any` scripts `specs_decision`/`signoff_decision`. Open questions are now `{question, recommendation, why}` (spec author) and brainstorm questions carry a `recommendation`; an empty answer takes it. Auto goes ahead without a person only when: specs - reviewer approved with nothing blocking and no prompt injection, check passed, no conflicts, every question recommended (at most 10); sign-off - tests passed, the REVIEW ITSELF approved, nothing CRITICAL, no prompt injection, PR not a draft, no `check_by_hand` finding left. DECISION (user said "yes" to an either/or question; read as strict): a Story whose review asked for changes still gets its one fix round, but a person then signs the unreviewed fix off (reason `fix_not_reviewed`). To loosen: let `fix_ran` with passing fix tests count in `examples/sdd-story/scripts/signoff_gate.py` (it did this in the first build). Not built: stopping the loop (rather than asking) for doubtful Stories - a doubtful Story waits up to 72h at its approval, as supervised.
- **Engine trap 3 (found by running Phase 3)**: a `merge: any` join that reads a step which always runs (here `spec_change`) is never blocked, so a REJECTED approval still reaches it. `specs_ok` (a condition on the join's `by != null`) stops `apply`. A join must read only the alternatives it joins, or be followed by a gate. Also: reading a field of a `{found: false}` output fails the run, use `has()`.
- **Engine trap 2 (probe)**: a parent sees a child's TOOL step as `{observation, output}` (plus `action` for writes), not the bare result; a script step is bare. `examples/ai-sdlc-factory/scripts/outcome.py` reads `nodes.open_pr.url` directly and its tests use bare fixtures, so a real lap probably always reports `sent_back`. Not run on the lap itself.
- **Phase 2 differences from this plan**: the autonomy approval offers `supervised` only (a `mode.py` script is the seam for Phase 3); `split_outcome`/`story_outcome` carry `last`; sub-issue titles are cleaned (control characters and `<` `>` removed) before Slack; `story_outcome` accepts only branches the next Story's `stack_on` input accepts; a single-issue epic's title is unknown (`github.create-issue` returns no title) so its row shows no title.
- **A step that reads a skipped step is skipped, even behind `has()`** (confirmed by a run: `has(nodes.b) ? nodes.b.output : nodes.a.output` on a step without `merge: any` is skipped when `b` was). So read alternatives only through a `merge: any` join. `sdd-story` does: `spec_change` now also outputs the passing round's `check`. `openspec-flow` still reads `check_2`/`pass_2` directly in `spec_review`, `proposal_approval`, `apply`, `verify` and `archive`, so its usual route (first proposal passes) would skip them all. Not run on `openspec-flow` itself and not changed here.
- **Existing issue, mechanism confirmed**: a child run is ended at its step's timeout plus one minute, even while it waits on a person (tested with 5s). `ai-sdlc-factory`'s `deliver` step sets no timeout, so it gets the one hour default; a delivery that takes longer would be ended. Not reproduced on that workflow and not changed here.
- **Confidence for one-pass success**: 6/10 for Phases 0 to 2, lower for Phase 3 until the spec author's schema is checked for per-question recommendations.
