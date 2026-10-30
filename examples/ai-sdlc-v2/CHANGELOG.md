# Changelog

## Findings and unmet criteria block the pull request

- Findings and unmet criteria now block, not only flag. `finalize` sets `ship: false` and lists `blockers` (also as
  `blockers_text`) for a confirmed critical finding, an unmet acceptance criterion, acceptance criteria the reviewer did
  not judge (it compares the count with `requirements.acceptance_criteria`; `criteria` is now required in
  `verdict.json`), or a build that ran out of steps (`workspace.step_limit_reached`). The run goes to `send_back` with
  the reasons. Major findings and partial criteria still open a flagged draft.
- `finalize` keeps the last reviewed round's findings when the fix round is not reviewed again, and the pull request
  body now lists the findings (id, severity, `path:line`, message, confidence), the unverified and dropped ones, and
  the criteria that are not met.
- Build and fix steps allow 40 model calls instead of 10 (the limit counts model calls, not gateway calls).

## Shared contexts for repeated inputs

| Gap | Change |
|---|---|
| The engineer's input (environment, ticket, requirements, design, decisions) was written out three times, once for the tested, the static-checks and the untested build, and each review round's change (a seven-field CEL map) was written twice per round, so an edit to one copy was easy to miss | `contexts:` defines `delivery_brief` (the three builds), and `round_1` and `round_2` (the lite reviewer and the verifier of each round). The seven steps list `context:` instead of repeating the map; the verifiers add their `findings` as their own input key. |

Nothing the workflow does changes: the compiled plan has the same order, data edges, taint and diagnostics as before, and every one of the seven steps gets the same input, key for key (`test/ai-sdlc-v2-contexts.test.ts` checks both against the plan from before the change). The contexts only hold values from steps the using steps already wait on, so they add no skip coupling. The shared `workspace:` block (about a dozen copies) is not covered by contexts and is unchanged. An installed copy is updated by the usual three-way merge. If you edited the old `input` of one of these seven steps, the update reports a conflict and keeps your `input`, and the merged step then fails to compile (`context_input_shape`: a `{map: ...}` input cannot be combined with a context) until you move your change into the context or into per-key values.

## Reviewers and verifiers see the change they review

| Gap | Change |
|---|---|
| The lite reviewers and the finding verifiers checked out the base branch and got the change only as diff text, so a verifier told to "refute the finding in a fresh checkout" had a checkout without the code it was checking | Those four steps (`lite_review_1/2`, `lite_verify_1/2`) set `workspace.from` to the change they review (`change_1` or `change_2`). The worker fetches that change's own base commit, applies its files and commits them locally, so the files are in the checkout and a diff against `refs/azhi/base` shows them. The diff stays in the message. |
| The reviewer and verifier instructions said the change was not in the folder | The command, skill, agent and profile text now says the folder holds the base with the change applied, and to confirm findings against the code as it is there. |

Needs a worker and a server on a build with workspace continuation (`docs/context-sharing.md`); a worker without it is refused for these steps at plan time, and the run plan says so. Not verified by a live run yet: the definition and plan checks pass, and the next delivery run is the check. Fix rounds still start from a fresh base and receive the previous diff as text; continuing them needs the fix skill rewritten, which is a separate change.

## Spec-driven planning (after OpenSpec and GitHub Spec Kit)

| Gap | Change |
|---|---|
| Acceptance criteria were free text, so plan, tests and review pointed at them by position | Each criterion is `AC-n: <subject> MUST ... GIVEN ... WHEN ... THEN ...`; tasks name the ids they satisfy (or `enabling`) and end with `Verify:`. The schema is unchanged: criteria are still strings. |
| The requirements lived only in the run, not in the repository | New planner skill `spec-driven-change`: in a repository that uses OpenSpec (`openspec/`) or spec-kit (`.specify/`), the plan's first tasks write the change's spec files (an OpenSpec change folder with proposal, delta specs and tasks, or a spec-kit feature spec). A repository with neither gets no new framework. Archiving into `openspec/specs/` stays a human step. |
| The plan never read what was already specified, or the project's written rules | The planner reads the current specs of the capability (a changed requirement is a modification, a contradiction is fixed or asked) and checks the plan against the project's rules (constitution, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`); a deviation is an open question that quotes the rule. |
| Gaps inside the plan (a criterion with no test task, a task that serves nothing) reached the engineer | The planner checks the plan against itself before it submits. |
| Spec files could drift from the code | The engineer ticks spec tasks only when done and updates a scenario it built differently; the code and lite reviewers treat a spec that disagrees with the code as `major`. |

Not verified by a live run yet: the definition checks pass, and the next delivery run on a repository with
an `openspec/` folder is the check.

## Gaps found by running it on a real ticket, and what changed

The first complete runs (issue #28 of this repository, pull request #36) exposed these. Each is listed with
what it cost and how the workflow now handles it.

| Gap found | Effect | Change |
|---|---|---|
| The run built on the repository's default branch, 165 commits behind the branch the ticket was written for | The plan said the ticket's files did not exist and proposed a duplicate of code that was there; a whole run was wasted | `base_branch` is a **required** input. The planner also checks whether the ticket's files exist and reports a likely stale base in `risks`. |
| The new tests were never executed in static mode | A test that could not pass reached review; the reviewer had to find it by reading | The static rung also **runs the test files the agent added or changed** (`scripts/verify_static.js`). A new test that fails blocks the change and the engineer gets the output. |
| The pull request said `Closes #28` while it had three open major findings | Merging the draft would have closed the ticket | `finalize` rewrites closing keywords to `Refs` unless the change is approved, fully verified and every criterion is met. |
| No answer to "is the ticket actually done?" | A reviewer had to infer it from findings | The reviewer returns a status and evidence for **each acceptance criterion**; the release approval shows the checklist; a partly met or unmet criterion keeps the pull request a draft. |
| The same classes of defect came back every time: a rule enforced on one path and bypassed on another, tests without boundary cases, a migration that adds nothing | Findings after the one fix round | The engineer has a **definition of done** (a test per criterion, every entry point, roles and tenants, tests that can pass, no empty migration). The fixer treats each finding as a **class** and searches the sibling code. The reviewer looks for the same list. |
| A no-op migration (`ADD COLUMN IF NOT EXISTS` on a column that exists) | Noise and a migration number spent | The planner and the reviewer both search `migrations/` first. |
| A non-ASCII character in a diff crashed `finalize` on Windows | A finished run failed at its last step | The scripts read and write UTF-8 explicitly, and the worker now sets `PYTHONUTF8` for every script. `test/ai-sdlc-v2-finalize.test.ts` covers it. |
| The worker's test environment dropped the SWC cache setting | Temporal's tests failed on Windows for a reason unrelated to the change | The worker passes `SWC_NATIVE_BINDING_CACHE` (a path, never a secret) to test commands. |
| The reader of an approval saw raw JSON and a wall of text | Hard to judge a change | The release approval shows the verdict, the criteria, the findings as cards (each with a jump to its line in the diff) and the diff. |

## Not done, and why

- **A baseline-aware test gate** (pass when no test fails that did not already fail on the base). It needs
  the engine to hand a node's output to a later step's test command, which a fixed command string cannot do.
- **More than one fix round.** It adds a second set of build, review and verify nodes per verification level;
  the sharper engineer and reviewer instructions are the cheaper first move.
