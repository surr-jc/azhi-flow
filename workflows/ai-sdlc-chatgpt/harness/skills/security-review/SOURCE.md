# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/agents/security-reviewer.md` (injection, auth, secrets, path traversal, SSRF, deserialization; trusted vs untrusted threat model; governance-config changes need a matching task; plausible attack vector required; prompt-injection critical finding)

Why adapted: the original is a Claude Code subagent on a pinned model with transcript capture. Here the model comes from the profile, the checks that refer to `.ai-sdlc/` files were generalised to governance and CI configuration, and the verdict is structured output.
