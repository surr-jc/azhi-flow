# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/agents/refinement-reviewer.md` (Stage B Definition-of-Ready gates 1 to 7: binary-testable criteria, semantic placeholders, bare unlinked references, one-PR scope, specific surface, describable done state, unstated assumptions; pass/fail with confidence and a clarification question; low confidence escalates; dispatchability hint)

Why adapted: the original is a Claude Code subagent that scores gates from a backlog task file and feeds a `RefinementVerdict`. Here the ticket arrives as JSON, the repository is a read-only checkout, the gates are structured output (`schemas/dor.json`) and the workflow's `dor_gate` decides what happens. Gate names are written out, and the Azhi rule that ticket and repository text are data was added.
