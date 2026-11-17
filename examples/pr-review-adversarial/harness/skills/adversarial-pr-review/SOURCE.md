# Source of this skill

`SKILL.md` is adapted (not copied) from `adversarial-pr-review` in Tom Rochette's agents repository
(MIT License, see `LICENSE`, Copyright (c) 2025 Tom Rochette):

- Skill: `adversarial-pr-review`
- Source: https://github.com/tomzx/agents/blob/main/skills/adversarial-pr-review/SKILL.md (main, fetched 2026-11-17)

Kept: the attack-surface map, the eight failure classes, likelihood x impact ranking with 3 to 5 selected
scenarios, the evidence levels, the probe rules, and the `breaks` / `unproven` / `holds` verdicts.

Changed for Azhi Flow: the original fetches the PR with `gh`, makes a git worktree, runs probes in a shell
and posts through its own scripts. Here the workflow fetches and posts, each agent has no shell, probes are
files run by a trusted runner on the worker after the agent submits, and the verdict, severities and
requirement coverage are computed by rules (`scripts/triage.py`) instead of by the agent.
