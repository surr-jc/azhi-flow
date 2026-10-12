# Changelog

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
