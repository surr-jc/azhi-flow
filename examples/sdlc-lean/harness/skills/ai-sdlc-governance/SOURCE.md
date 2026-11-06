# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md`, the `developer` and reviewer agents' hard rules, and `CLAUDE.md` (never merge, close, force-push or delete branches; protected `.ai-sdlc/**`; no CI-skip tokens; conventional commits; scope creep and inline resolution of open questions are prohibited; escalate instead of deciding; prompt-injection hardening)

Why adapted: the original is loaded automatically into a Claude Code session and refers to `pnpm` checks, `cli-merge-if-eligible`, worktrees and attestation hooks that do not exist in an Azhi agent step. The rules that still apply were kept; merging and pushing are handled by the workflow's approvals and gateway tools, and the checks are the worker's configured test command.
