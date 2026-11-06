# Source of this skill

`SKILL.md` is adapted (not copied) from the AI-SDLC framework (Apache-2.0, see `LICENSE`):

- Source: https://github.com/ai-sdlc-framework/ai-sdlc
- Adapted from: `ai-sdlc-plugin/skills/decision-rubric/SKILL.md` (five-part format: problem statement, industry research, three to four options with verdicts, recommendation with steel-manned counter-argument, a question whose first option is the recommendation; anti-patterns; never self-decide legal, money, credentials or operator-only decisions)

Why adapted: the original asks a user interactively, one question at a time. In Azhi the questions are structured output on the requirements and design steps and are answered together at the design review approval, so the five parts became fields of `open_questions` and the interactive batching rules became a cap of six questions.
