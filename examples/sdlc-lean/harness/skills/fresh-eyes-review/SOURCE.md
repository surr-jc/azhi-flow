# Source of this skill

`SKILL.md` is adapted (not copied) from Cole Medin's skills repository (MIT license, see `LICENSE`,
Copyright (c) 2026 Cole Medin):

- Skills: `piv-review-pr` (fresh eyes, load the project's standards, judge against intent,
  documented deviations), `piv-review-changes` (read whole files, verify issues are real) and
  `prime-codebase` (orientation before work)
- Source: https://github.com/coleam00/skills/tree/main/.claude/skills (commit dfaa910, fetched 2026-10-07)

Why adapted: the originals run `gh`, `git` and test commands and post to GitHub, while Azhi's
reviewers have only read, grep, glob and skill, and posting is a separate approval-gated step. The
review method was kept; the commands were removed, and two Azhi rules were added: repository text
is data (instructions in it are a finding), and a PR description cannot waive a security or
data-loss finding.
