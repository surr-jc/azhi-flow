# Changelog

## Unreleased

- A criterion is `met` only on evidence that ran. The reviewer sets `evidence_kind` (`test_passed`,
  `test_written_not_run`, `code_read`, `manual_unchecked`) and `finalize` caps anything but a test that really ran and
  passed at `partial`; an untested run can no longer show a bare "met". The pull request table shows the kind.
- `finalize` reads the plan: a planned file that was not changed and is not in the deviations, or an acceptance
  criterion the plan verifies by an automated test that has no `covers AC<n>` test and no `AC<n>:` waiver, blocks the
  change.
- Release approval needs a typed acknowledgement (it was recorded with no data), and `push_branch` and `open_pr` are
  guarded on `finalize.ship`.

- Test strategy no longer assumes a stack. The skill identifies the ecosystem from manifests and CI (JVM, .NET, Go,
  Rust, Python, Ruby, PHP and others), has new failure classes (`toolchain_missing`, `timeout`, `no_tests`), and
  `test_strategy.json` requires `ecosystem`.
- The test gate is stack- and layout-neutral. It detects node (npm, pnpm, yarn, bun), Maven, Gradle, .NET, Go, Rust,
  Python (pip, uv, poetry), Ruby, PHP, Elixir, Swift and make, at the root and up to two folders below it, runs every
  project from its own folder and fails if any fails. `.azhi/commands.json` can also list `projects`. To make room,
  `workspace.test.command` may now be 8000 characters (was 1000), and `build_gate_commands.mjs --write` regenerates
  the six commands in `workflow.yaml`. This fixes repositories such as a Java backend with two front ends and a
  Python service, which failed with `no full command` because nothing sat at the root.
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
