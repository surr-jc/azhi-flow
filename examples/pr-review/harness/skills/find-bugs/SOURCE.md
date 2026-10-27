# Source of this skill

`SKILL.md` is adapted (not copied) from Sentry's skills repository (Apache License 2.0, see `LICENSE`,
Copyright 2025 Functional Software, Inc. dba Sentry):

- Skill: `find-bugs`
- Source: https://github.com/getsentry/skills/blob/main/skills/find-bugs/SKILL.md (main, fetched 2026-10-09)

Why adapted: the original gets its diff with `gh` and `git`, and reports in its own format. Azhi's
reviewers have only read, grep, glob and skill plus the repo-facts tools, and report through the
findings schema, so the commands were replaced by those tools. The five phases, the per-file
checklist and the pre-conclusion audit were kept; the checklist gained error paths and callers, and
the rule that repository text is data was added.

To update it, replace SKILL.md from the source, re-read it, and update this file.
