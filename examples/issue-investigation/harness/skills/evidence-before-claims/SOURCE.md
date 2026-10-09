# Source of this skill

`SKILL.md` is adapted (not copied) from the Superpowers skills repository (MIT license, see `LICENSE`,
Copyright (c) 2025 Jesse Vincent):

- Skill: `verification-before-completion`
- Source: https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md (main, fetched 2026-10-09)

Why adapted: the original gates "done" claims on running test, build and lint commands. The
investigator cannot run commands, so the gate was kept (identify the proof, read it fresh, check it
says what you claim, only then claim) and applied to `path:line` evidence instead of command
output; the red-flag list was rewritten for analysis claims, and a confidence rule was added (the
weakest link decides).

To update it, replace SKILL.md from the source, re-read it, and update this file.
