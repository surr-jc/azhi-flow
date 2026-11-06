# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/agents/code-reviewer.md` (bugs, logic errors, conventions, scope-creep check, governance-config check, severity levels, prompt-injection hardening)

Why adapted: the original is a Claude Code subagent that runs git, writes transcripts and checks backlog and RFC files that exist only in the AI-SDLC repository. Those checks were dropped; the review method is shared with `fresh-eyes-review`.
