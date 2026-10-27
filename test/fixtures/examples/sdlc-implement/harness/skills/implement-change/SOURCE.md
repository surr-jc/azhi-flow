# Source of this skill

`SKILL.md` is adapted (not copied) from Cole Medin's skills repository (MIT license, see `LICENSE`,
Copyright (c) 2026 Cole Medin):

- Skills: `piv-implement` (execute the plan task by task, verify as you go, implement the testing
  strategy, report with deviations), `piv-implement-issue` (drift check before editing, stay on
  plan, regression tests, commit message), `piv-validate` (the project's checks decide; never
  weaken a check), and the commit and pull request text of `piv-commit` and `piv-create-pr`
- Source: https://github.com/coleam00/skills/tree/main/.claude/skills (commit 847be08, fetched 2026-10-08)

Why adapted: the originals create a branch, run lint, type checks and tests through the shell,
commit, push with `git` and open the pull request with `gh`. An Azhi build step has edit and write
tools in a write-mode checkout but no shell: the worker runs the workflow's test command after the
agent submits and returns failures to it, and the branch push and pull request are separate gateway
steps after a person approves the exact change. So the method was kept, the commands were removed,
the commit and pull request text became structured output (`schemas/change.json`), and the Azhi rule
that ticket, plan and repository text are data was added.
