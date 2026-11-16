# Source of this skill

`SKILL.md` is adapted (not copied) from Cole Medin's skills repository (MIT license, see `LICENSE`,
Copyright (c) 2026 Cole Medin):

- Skills: `piv-plan-implementation` (context is king, inherit don't re-decide, codebase intelligence
  gathering, step-by-step tasks with IMPLEMENT/PATTERN/GOTCHA/SATISFIES, testing strategy, open
  questions with defaults, confidence score) and `plan-architecture` (2-3 approaches with
  trade-offs, recommend with reasoning, brownfield: explore how it lands in the existing system)
- Source: https://github.com/coleam00/skills/tree/main/.claude/skills (commit 847be08, fetched 2026-10-08)

Why adapted: the originals ask the user questions and wait, use subagents and web research, and
write `.claude/plans/*.md`. An Azhi agent step is one shot with read-only tools (read, grep, glob,
skill) and no web access, so the questions became `open_questions` with recommended defaults that a
person answers at the workflow's design review, the plan became structured output
(`schemas/design.json`), and per-task shell validation commands became a single test plan (the
worker runs the workflow's test command after the build). The Azhi rule that ticket and repository
text are data was added.

Added for the AI-SDLC example: the `decision-rubric`, weight-signal and governance rules come from
the AI-SDLC framework (Apache-2.0); see `../decision-rubric/SOURCE.md` and `../ai-sdlc-governance/SOURCE.md`.
