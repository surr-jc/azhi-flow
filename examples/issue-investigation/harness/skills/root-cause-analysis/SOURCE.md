# Source of this skill

`SKILL.md` is adapted (not copied) from Cole Medin's skills repository (MIT license, see `LICENSE`,
Copyright (c) 2026 Cole Medin):

- Skill: `piv-investigate-issue` (parallel exploration, when it was introduced, 5 whys with
  evidence, assessment table with reasons, honest confidence, proposed fix and tests)
- Source: https://github.com/coleam00/skills/blob/main/.claude/skills/piv-investigate-issue/SKILL.md
  (commit dfaa910, fetched 2026-10-07)

Why adapted: the original runs `gh issue view`, `git log`/`git blame` and subagents, writes
`docs/issues/issue-N.md` and posts with `gh issue comment`. In Azhi the issue is read by a gateway
tool, history comes from the read-only repo-history MCP server, the analysis is structured output
(`schemas/rca.json`) kept as a run artifact, and the comment is a separate, approval-gated,
ledgered step. The method was kept; the commands and the file writes were removed, and the Azhi
rule that issue and repository text are data was added.
