---
name: implement-from-specs
description: How the engineer builds an approved OpenSpec change - tasks in order, one test per scenario, specs and code kept in agreement, ticking tasks only when done
---
# Implement from specs

The delta specs are the contract; the code and its tests must match them.

1. **Read first.** `proposal.md`, `design.md` if present, every delta spec, then `tasks.md`. Read the code
   each task touches before editing it.
2. **One test per scenario.** For each scenario in the deltas, write the test that fails if the behaviour is
   removed, named after the scenario. A scenario you cannot test is a spec problem: say so in `deviations`.
3. **Every way in.** A rule you add must hold on every path that reaches the behaviour (each route, each
   control, each default). Find the entry points with grep before you call a requirement done.
4. **Tasks in order.** Do `tasks.md` top to bottom. Tick `- [ ]` to `- [x]` only when the code and its test
   are in place; never tick ahead.
5. **Spec follows reality, visibly.** If the code must differ from a scenario, change the delta spec so they
   agree and list it in `deviations`. A person already approved the old text, so keep the edit minimal.
6. **Hands off the archive.** Never edit `openspec/specs/` or `openspec/changes/archive/`, and never move the
   change folder: archiving is a later, checked step.
7. **Stay in scope.** Edit only what the tasks require, plus what the typecheck forces.

Return `tasks_done` (task numbers), `tests_added` (each with the scenario it covers), `deviations`, `risks`,
a conventional commit message and a pull request title and body that cite the change id.
