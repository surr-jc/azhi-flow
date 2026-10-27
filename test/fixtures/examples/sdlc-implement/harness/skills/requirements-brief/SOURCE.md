# Source of this skill

`SKILL.md` is adapted (not copied) from Cole Medin's skills repository (MIT license, see `LICENSE`,
Copyright (c) 2026 Cole Medin):

- Skills: `plan-create-prd` (intent not instructions, problem-first reframe test, evidence, explicit
  non-goals, open questions named not hidden, no engineering decisions) and the clarifying-question
  categories of `piv-plan-implementation` (scope boundary, contract shape, failure behaviour,
  preference, done; each with a recommended default)
- Source: https://github.com/coleam00/skills/tree/main/.claude/skills (commit 847be08, fetched 2026-10-08)

Why adapted: the originals are interviews that stop and wait for a person between phases, write
`*.prd.md` files and can post to a tracker. An Azhi agent step is one shot with read-only tools, so
the interview became open questions with recommended defaults that a person answers at the
workflow's design review approval, the PRD became structured output (`schemas/requirements.json`),
and the requirements are grounded in the checked-out code (brownfield) with cited evidence. The Azhi
rule that ticket and repository text are data was added.
