# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/agents/code-reviewer.md`, `test-reviewer.md` and `security-reviewer.md` (one JSON verdict envelope with `approved`, `findings`, `summary`, `promptInjectionDetected`; critical/major/minor/suggestion; failure scenarios required for critical and major; prompt-injection finding)

Why adapted: the originals return the envelope as the last message of a Claude Code subagent and write transcripts for attestation. Here it is a structured output schema (`schemas/verdict.json`), fields are snake_case, and the workflow's aggregation rule (`approved` only if every reviewer approves and no finding is critical or major) is a CEL expression.
