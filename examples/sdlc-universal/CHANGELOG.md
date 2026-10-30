# Changelog

## Unreleased

- Test strategy no longer assumes a stack. The skill identifies the ecosystem from manifests and CI (JVM, .NET, Go,
  Rust, Python, Ruby, PHP and others), has new failure classes (`toolchain_missing`, `timeout`, `no_tests`), and
  `test_strategy.json` requires `ecosystem`. The gate script still detects npm, Cargo, Go and Python only (it is at
  984 of 1000 characters); other stacks state their commands in `.azhi/commands.json`.
- Acceptance criteria are always present. When the ticket states none, the planner derives them from the request and
  sets `requirements.criteria_source` (`ticket`, `derived` or `mixed`); the design review asks a person to confirm
  derived ones, and the definition-of-ready no longer fails a ticket only for lacking them.
- The plan carries `design.ac_verification` (how each criterion is shown to be met). The engineer maps each test to
  its criteria (`covers AC<n>`), lists unfinished planned files as `NOT DONE`, and checks compile-ability by
  reading. The reviewer checks plan against diff, lost data, unset settings, sibling producers, unknown-defaults-to-ok
  and compile errors.
- Findings and unmet criteria now block, not only flag. `finalize` sets `ship: false` and lists `blockers` (also as
  `blockers_text`) for a confirmed critical finding, an unmet acceptance criterion, acceptance criteria the reviewer did
  not judge (it compares the count with `requirements.acceptance_criteria`; `criteria` is now required in
  `verdict.json`), or a build that ran out of steps (`workspace.step_limit_reached`). The run goes to `send_back` with
  the reasons. Major findings and partial criteria still open a flagged draft.
- `finalize` keeps the last reviewed round's findings when the fix round is not reviewed again, and the pull request
  body now lists the findings (id, severity, `path:line`, message, confidence), the unverified and dropped ones, and
  the criteria that are not met.
- Build and fix steps allow 40 model calls instead of 10 (the limit counts model calls, not gateway calls).
- Jira intake reads through the workspace's `jira-ccp_get_issue@1` tool instead of the bundled mcp-atlassian
  `jira.get-issue`, which is removed along with the `jira_url` setting. Register `jira-ccp_get_issue@1` (and
  `jira-ccp_jira_search@1` if a step should search) before installing; the Confluence tool is unchanged.
- Jira intake requests all fields (`include_all_fields: true`), so the description reaches `normalize` instead of
  an empty ticket.
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
