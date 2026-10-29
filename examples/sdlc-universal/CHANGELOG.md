# Changelog

## Unreleased

- Jira intake reads through the workspace's `jira-ccp_get_issue@1` tool instead of the bundled mcp-atlassian
  `jira.get-issue`, which is removed along with the `jira_url` setting. Register `jira-ccp_get_issue@1` (and
  `jira-ccp_jira_search@1` if a step should search) before installing; the Confluence tool is unchanged.
- Meant for workers running OpenCode 2 (`AZHI_OPENCODE_MAJOR=2`, `azhi setup --opencode2`); the steps still say
  `executor: opencode`, the worker picks the version.

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
