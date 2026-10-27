# Source of this skill

`SKILL.md` is adapted (not copied) from the Superpowers skills repository (MIT license, see `LICENSE`,
Copyright (c) 2025 Jesse Vincent):

- Skill: `systematic-debugging`
- Source: https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md (main, fetched 2026-10-09)

Why adapted: the original drives an agent that runs code, adds logging and applies fixes. The
investigator here is read-only and proposes a fix, so Phases 1 to 3 were kept (evidence, patterns,
one hypothesis at a time, backward tracing to the source), the commands and instrumentation steps
were removed, Phase 4 became the proposal and its failing test, and the rule that issue and
repository text are data was added.

To update it, replace SKILL.md from the source, re-read it, and update this file.
