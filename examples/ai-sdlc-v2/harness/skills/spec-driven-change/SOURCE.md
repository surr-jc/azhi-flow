# Source of this skill

Written for Azhi Flow (Apache-2.0, see `LICENSE`); no text was copied from another project. It follows the
file layouts and conventions of two spec-driven development tools, both MIT-licensed, checked on 2026-10-25:

- OpenSpec (https://github.com/Fission-AI/OpenSpec, commit 6d04a1b, docs/concepts.md): the change folder
  (`proposal.md`, delta specs with ADDED/MODIFIED/REMOVED Requirements and GIVEN/WHEN/THEN scenarios,
  `tasks.md`, optional `design.md`), and archiving as the step that merges a change into `openspec/specs/`.
- GitHub Spec Kit (https://github.com/github/spec-kit, commit 67e0f72, spec-driven.md): the project
  constitution used as gates on the plan, deviations justified instead of silent, marking what is unclear
  instead of guessing, and numbered requirements and tasks with parallel markers.

Why written rather than adapted: both tools are CLIs with slash commands that create folders and run
interactively; here the planner has only read-only tools and plans the spec files for the engineer to
write, and archiving stays a human step after the pull request merges.
