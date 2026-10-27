# Changelog

## 1.0.0

Derived from AI-SDLC v2 (see `../ai-sdlc-v2/CHANGELOG.md` for its history).

- Intake from Jira (`jira.get-issue`) as well as GitHub, and one optional Confluence page
  (`confluence.get-page`), merged into the ticket by `scripts/merge_context.py`.
- Provider-neutral profiles: `name: default` out of the box, or one model per tier from `models.json`
  with `scripts/apply_models.mjs` (Anthropic, GitHub Copilot, ChatGPT plan).
- The test gate is language-neutral (`scripts/gate.js`): detected from the repository, or stated in
  `.azhi/commands.json`. The Azhi-specific test, type-check and build commands are gone.
- The Slack channel is a setting, not a value in the workflow.
- Removed the profiles and harness files this workflow does not use (security, test and second code
  reviewers, analyst, architect).
