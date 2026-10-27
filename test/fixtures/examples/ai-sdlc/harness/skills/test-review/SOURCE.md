# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/agents/test-reviewer.md` (test existence, quality and edge cases, naming, exclusions for type-only files and config, defer coverage numbers, severity rules, approve with suggestions when uncertain)

Why adapted: the original also checks backlog-task scope creep and RFC open questions specific to the AI-SDLC repository; those were dropped. The worker's real test result is part of the input.
