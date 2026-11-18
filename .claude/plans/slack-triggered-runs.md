# Feature: Slack-triggered workflow runs (`/azhi run`) with results in the thread

The following plan should be complete, but validate the codebase patterns and task sanity before you start implementing.
Pay special attention to the names of existing helpers (`startRun`, `postMessage`, `resolveSecret`, `verifySlackSignature`, `audit`) and import them from the files listed below.

## Feature Description

A person types `/azhi run <workflow> key=value ...` in Slack. Azhi Flow verifies the request, maps the Slack user to a linked Azhi Flow user, checks that the workflow is on the workspace's Slack allowlist, starts the run as that user, and replies in a Slack thread. Approvals for that run are posted into the same thread, and the final result (state, duration, link to mission control) is posted there when the run ends.

## User Story

As an operator who lives in Slack
I want to start an allowlisted workflow from a slash command and follow it in one thread
So that I can trigger and watch governed runs without opening mission control, while role checks, approvals and the audit trail still apply.

## Problem Statement

Slack is output-only today (`slack.post-message`) plus approval buttons (`POST /v1/slack/interactions`). Nothing starts a run from Slack, and nothing ties a run to a Slack thread, so results are only visible if a workflow itself has a `notify` step.

## Solution Statement

1. `POST /v1/slack/commands`: signature-verified slash-command route that parses `run <workflow> k=v ...`, resolves the Slack user, enforces role and allowlist, calls `startRun`, and acks within 3 s.
2. New table `slack_run_threads(run_id, workspace_id, channel, thread_ts, requested_by)` links a run to its thread.
3. Approvals for a threaded run post into that thread (small change in `postApprovalToSlack`).
4. A server-side notifier (same shape as `startAlertNotifier`) posts the final result into the thread once, using the deduplicated `postMessage`.
5. Per-workspace setting `settings.slack_commands = { enabled, workflows: [slug...] }`, plus a Settings UI panel and docs.

Optional later (out of scope here): `app_mention` via the Events API; a `/azhi status <run>` and `/azhi cancel <run>`.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: `src/api/slack.ts`, `src/server/` (new `slack-runs.ts`), `src/server/approvals.ts`, `src/server/server.ts` (notifier wiring), `migrations/`, `web/src/pages/Approvals.tsx`, `docs/`
**Dependencies**: none new. Slack app needs a Slash Command pointing at `<publicUrl>/v1/slack/commands`, scope `commands`, plus existing `chat:write`.

---

## CONTEXT REFERENCES

### Relevant Codebase Files: READ BEFORE IMPLEMENTING

- `src/api/slack.ts` (all, esp. 22-53, 78-120) - signature verification (`verifySlackSignature`), raw form-body parsing via `addContentTypeParser(... parseAs: 'string')`, Slack-user to Azhi-user lookup (`users.slack_user_id`), `respond()` to `response_url`, "first decision wins" style error replies. The new route mirrors this.
- `src/gateway/tools/slack.ts` (32-45) - `postMessage({token, apiUrl}, {channel, text, blocks, threadTs, dedupeKey})`; every post carries the dedupe key in message metadata.
- `src/server/start-run.ts` (16-58) - `startRun(ctx, principal, body, interpreterBuild)` and `startRunBody`; trigger is recorded as `'api'`, role must be checked by the caller (`operator`).
- `src/api/app.ts` (105, 140, 315-320) - `buildApi` has `interpreterBuild`; `registerSlackRoutes(app, ctx, temporal)` is called at line 140, so the new route needs `interpreterBuild` threaded in (see Task 4). `POST /v1/runs` is the role-check pattern (`requireRole(p, 'operator')`).
- `src/server/approvals.ts` (50-54, 132-147) - `approvalSettings`, `postApprovalToSlack` (claims `approval_messages`, then posts). Needs a thread lookup.
- `src/server/alerts.ts` (128-137, 185-201) - `sendSlackAlert` and `startAlertNotifier` (setInterval, `running` guard, `tick`/`stop`). The final-result notifier mirrors this.
- `src/runtime/types.ts:5` - `TERMINAL_STATES`; `src/runtime/gateway-activities.ts:66-99` - `recordRun` writes state/ended_at/error on `runs`.
- `src/server/runs.ts` (110-147) - `createRun`; `runs` columns: `state, inputs, ended_at, error, created_by, trigger`.
- `src/server/secrets.ts` - `resolveSecret(ctx, ws, 'slack-bot-token' | 'slack-signing-secret')`.
- `src/server/catalog.ts` - `audit(ctx, ws, userId, kind, data)`.
- `src/server/workflows.ts` - `resolveVersion(ctx, ws, 'slug@latest')`; workflow `slug` is the allowlist key.
- `src/testing/fake-slack.ts` - fake Slack API (`messages`, `views`, `responses`); extend only if a new Slack method is needed (none expected).
- `migrations/0004_team.sql` - `approval_messages` shape to mirror; latest migration was `0013_mcp_oauth_discovery.sql` when planned (renumbered after rebase), so the new one is `0016_slack_runs.sql`. Add the new table to `RUN_CHILD_TABLES` in `src/server/workflows.ts:133`.
- `web/src/pages/Approvals.tsx` (144-170) - `SlackApprovals` settings panel to mirror for "Run from Slack".
- `test/slack-answers.test.ts`, `test/approvals.test.ts` (1-60) - unit-test style and Temporal-gated harness style (`startHarness`, `h.slack`, `waitForRun`).
- `docs/mission-control-plan.md`, `docs/assistant.md` - doc style; add `docs/slack-runs.md` (one file per feature, per CLAUDE.md).

### New Files to Create

- `migrations/0016_slack_runs.sql` - `slack_run_threads` table.
- `src/server/slack-runs.ts` - settings reader, command parser, allowlist check, thread record, final-result notifier.
- `test/slack-runs.test.ts` - unit tests (parser, allowlist, text) and a harness test (command to run to thread).
- `docs/slack-runs.md` - setup and behaviour.

### Patterns to Follow

**Untrusted text (CLAUDE.md rule)**: the command text is data. The workflow is looked up by exact slug against the allowlist; `key=value` pairs become `inputs` strings only. Never build a shell string, tool name or version from them. Reject keys not matching `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`, cap value length (1000) and pair count (20).

**Error handling**: `AzhiError(ErrorClass.invalidInput | authorization, msg)` from `src/lib/errors.js`; for Slack, return a 200 with an ephemeral `{ response_type: 'ephemeral', text }` rather than an HTTP error, except a bad signature (401), as `slack.ts` does.

**Unknowns are null**: if the run has no `error` message or duration is unknown, say "unavailable", never guess.

**Audit**: `audit(ctx, ws, userId, 'slack.run_started', { run, workflow, slack_user })`, matching `approval.commented` style.

**Naming**: files kebab-case, ESM imports end in `.js`, conventional commits (`feat:`), work on `dev`.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation
Migration, settings shape, pure helpers (parser, allowlist, result text).

### Phase 2: Core Implementation
`/v1/slack/commands` route; thread record on start; final-result notifier.

### Phase 3: Integration
Approval messages into the thread; wire notifier into the server; settings API and UI panel; docs.

### Phase 4: Testing & Validation
Unit tests for pure helpers; harness test with fake Slack for the end-to-end flow; edge cases.

---

## STEP-BY-STEP TASKS

### CREATE migrations/0016_slack_runs.sql
- **IMPLEMENT**:
  ```sql
  CREATE TABLE slack_run_threads (
    run_id        text PRIMARY KEY,
    workspace_id  text NOT NULL REFERENCES workspaces(id),
    channel       text NOT NULL,
    thread_ts     text,            -- set once the first message is posted
    requested_by  text NOT NULL,   -- Azhi Flow user id
    slack_user_id text NOT NULL,
    result_posted_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX slack_run_threads_open ON slack_run_threads (workspace_id) WHERE result_posted_at IS NULL;
  ```
- **PATTERN**: `migrations/0004_team.sql:10-18`.
- **GOTCHA**: confirm how migrations are discovered/applied (`src/db/`) so PGlite picks it up.
- **VALIDATE**: `npx vitest run test/slack-runs.test.ts` (after Task 7), `npm run typecheck`

### UPDATE src/server/workflows.ts
- **ADD**: `'slack_run_threads'` to `RUN_CHILD_TABLES` (line 133) so deleting runs cleans it.
- **VALIDATE**: `npm run typecheck`

### CREATE src/server/slack-runs.ts
- **IMPLEMENT**:
  - `interface SlackCommandSettings { enabled?: boolean; workflows?: string[]; channel?: string }` and `slackCommandSettings(ctx, ws)` reading `workspaces.settings->'slack_commands'` (mirror `approvalSettings`).
  - `parseRunCommand(text): { workflow: string; inputs: Record<string,string> }`: tokens split on whitespace; first token must be `run`; second is the workflow slug (`/^[a-z0-9][a-z0-9-]{0,63}$/`); the rest `key=value` (support double-quoted values). Throws `AzhiError(invalidInput, <usage text>)`.
  - `isAllowed(settings, slug)`.
  - `resultText(run, link)`: one line, `:white_check_mark:`/`:x:` by state, workflow, state, duration or "unavailable", error message clipped with `clip()` from `slack-format.js`, link `<${publicUrl}/ui/runs/${id}|Open in mission control>`; escape with `escapeMrkdwn`.
  - `postRunResults(ctx, log)`: select `slack_run_threads t JOIN runs r` where `t.result_posted_at IS NULL AND r.state = ANY(TERMINAL_STATES)`; per row `resolveSecret` then `postMessage({token, apiUrl}, {channel, threadTs, text, dedupeKey: 'run-result:'+run_id})`; set `result_posted_at=now()`; failures `audit(... 'slack.run_result_failed')` and retry next tick.
  - `startSlackRunNotifier(ctx, log, intervalMs = 5000)` copying `startAlertNotifier`'s `running` guard and `{ tick, stop }` return.
- **PATTERN**: `src/server/alerts.ts:128-201`; `src/api/slack.ts:120-134` for `postMessage` with `threadTs`.
- **IMPORTS**: `postMessage` from `../gateway/tools/slack.js`; `clip, escapeMrkdwn` from `../gateway/tools/slack-format.js`; `TERMINAL_STATES` from `../runtime/types.js`; `resolveSecret`; `audit`; `AzhiError, ErrorClass`.
- **GOTCHA**: thread_ts is only known after the first post, so the ack message is posted with `chat.postMessage` (not just the slash-command reply) to obtain a `ts`; use that `ts` as the thread root. If `threadTs` is null at result time, post top-level in the channel.
- **VALIDATE**: `npx vitest run test/slack-runs.test.ts`

### UPDATE src/api/slack.ts
- **ADD** `SLACK_COMMANDS = '/v1/slack/commands'` and a route inside the existing sub-plugin (same raw-body content-type parser):
  1. Parse `new URLSearchParams(raw)`; fields `command`, `text`, `user_id`, `channel_id`, `team_id`, `response_url`.
  2. Workspace resolution: Slack commands carry no run id, so resolve the workspace by trying `slack-signing-secret` for workspaces that have `settings->'slack_commands'->>'enabled' = 'true'` and accept the first whose signature verifies (usually one). 401 if none verify.
  3. `settings.enabled` else ephemeral "Slack commands are not enabled".
  4. Linked user lookup (same SQL as line 108). Unlinked: ephemeral message pointing to the Users page.
  5. `requireRole(principal, 'operator')` inside try; ephemeral on failure.
  6. `parseRunCommand`; `isAllowed` else ephemeral "not allowed from Slack" (list allowed slugs).
  7. `startRun(ctx, principal, { version: `${slug}@latest`, inputs }, interpreterBuild)`; map `AzhiError` to an ephemeral message (budget, plan blockers, unknown workflow).
  8. Post the thread root with `postMessage` (dedupeKey `run-start:${runId}`) to `settings.channel ?? channel_id`; insert `slack_run_threads`; `audit('slack.run_started')`.
  9. Reply 200 within 3 s with `{ response_type: 'ephemeral', text: 'Started <runId>. Follow it in the thread.' }`. Start the run and post before replying only if fast; otherwise reply first and use `response_url` (`respond()`) for errors.
- **PATTERN**: `src/api/slack.ts:81-120`.
- **GOTCHA**: `registerSlackRoutes` needs `interpreterBuild`; change the signature to `registerSlackRoutes(app, ctx, temporal, interpreterBuild)` and update the call at `src/api/app.ts:140`.
- **GOTCHA**: a bad signature must not reveal which workspaces exist.
- **VALIDATE**: `npm run typecheck`

### UPDATE src/server/approvals.ts
- **IMPLEMENT**: in `postApprovalToSlack`, after the `approvalSettings` check, look up `slack_run_threads` for the run; if it has `channel` and `thread_ts`, post there with `threadTs` (and record that channel in `approval_messages`). Also allow posting when `s.slack_channel` is unset but a thread exists.
- **PATTERN**: current body at lines 132-147.
- **GOTCHA**: button clicks find the message through `approval_messages` (`slack.ts:100`), so the row must still be written.
- **VALIDATE**: `npx vitest run test/approvals.test.ts test/slack-answers.test.ts`

### UPDATE src/server/server.ts
- **ADD**: start `startSlackRunNotifier` wherever `startAlertNotifier` is started (role `scheduler` or `api`; match that placement) and stop it on shutdown.
- **VALIDATE**: `npm run typecheck`

### UPDATE src/api/slack.ts (settings endpoints)
- **ADD**: `GET/PUT /v1/settings/slack-commands` (admin to PUT): `{ enabled: boolean, workflows: string[] (max 50), channel: string|null }`, audit `settings.slack_commands_changed`; GET also returns `command_url`, and whether the secrets are set.
- **PATTERN**: `/v1/settings/approvals` at `slack.ts:56-76`.
- **VALIDATE**: `npm run typecheck`

### UPDATE web/src/pages/Approvals.tsx (or a new settings component)
- **ADD**: "Run from Slack" panel: enable toggle, allowlist (comma/chip list of workflow slugs), channel override, copyable command URL, secrets warnings.
- **PATTERN**: `SlackApprovals`, lines 144-170.
- **VALIDATE**: `npm run typecheck` and `npm run build:web`

### CREATE test/slack-runs.test.ts
- **IMPLEMENT**:
  - Unit: `parseRunCommand` (quotes, bad key, too many pairs, non-`run` verb, hostile text like `;rm -rf` stays an inert string); `isAllowed`; `resultText` (unknown duration prints "unavailable").
  - Harness (`describe.skipIf(!up)`, `startHarness`, `h.slack`): enable settings + allowlist, link a Slack user, POST a signed form body to `/v1/slack/commands`; expect a run, a `slack_run_threads` row, an approval message with the thread's `thread_ts`, and after finishing exactly one `run-result:` message (dedupe: call `tick()` twice).
  - Refusals: bad signature 401; unlinked user; viewer role; workflow not on the allowlist; disabled.
- **PATTERN**: `test/approvals.test.ts`, `test/slack-answers.test.ts`. Sign with the same `v0=` HMAC scheme as `verifySlackSignature`.
- **VALIDATE**: `npx vitest run test/slack-runs.test.ts`

### CREATE docs/slack-runs.md and UPDATE README.md
- **IMPLEMENT**: Slack app setup (slash command URL, scopes `commands`, `chat:write`), settings, behaviour, security model (linked user and role, allowlist, input handling as untrusted data), limits. Add a one-line link in README near the Slack paragraph (line ~306).
- **VALIDATE**: `npm run typecheck`

---

## TESTING STRATEGY

### Unit Tests
Pure helpers in `slack-runs.ts` (parser, allowlist, text), table-driven.

### Integration Tests
Harness test against the fake Slack API: command to run to thread root to approval in thread to single result message. Skipped automatically when Temporal is unavailable (`temporalAvailable()`), so the pure tests must carry the main logic.

### Edge Cases
- Signature stale (more than 5 min) or wrong secret: 401, nothing started.
- Slack retries the same command (it can resend on timeout): dedupe so only one run starts. Key on `trigger_id`/`X-Slack-Retry-Num`; at minimum return 200 and skip when `X-Slack-Retry-Num` is present.
- Two workspaces with signing secrets: only the verifying one is used.
- Budget exceeded / plan blockers: ephemeral error, no run.
- Run ends before the ack post finishes: notifier posts top-level or waits for `thread_ts` (skip rows with null `thread_ts` for one tick).
- Result text containing Slack mrkdwn or mentions (`<!channel>`): escaped via `escapeMrkdwn`.
- Test-mode runs and `model_defaults` are not exposed to Slack.

### E2E / Browser Automation
Settings panel only: open `/ui/approvals`, enable the toggle, add a slug, save, reload and assert persistence; screenshot to `screenshots/slack-runs-settings.png`. The Slack flow itself is covered by the fake-Slack harness test.

---

## VALIDATION COMMANDS

### Level 1: Syntax & Style
`npm run typecheck`

### Level 2: Unit Tests
`npx vitest run test/slack-runs.test.ts test/slack-answers.test.ts test/slack-format.test.ts`

### Level 3: Integration Tests
`npm run test:local` (runs on PGlite; Temporal-gated tests skip without a server)

### Level 4: Manual Validation
Run the server with `AZHI_SLACK_API_URL` pointing at `startFakeSlack` (see README ~306), then `curl` a signed form body to `/v1/slack/commands` and read `GET /v1/runs/<id>` and the fake Slack `messages`.

### Level 5: E2E / Browser Automation
`npm run build:web`, start the server (preview), exercise the settings panel as above.

---

## ACCEPTANCE CRITERIA

- [ ] `/azhi run <workflow> k=v` starts a run as the linked Azhi user with that user's role
- [ ] Unlinked users, roles below operator, disabled setting and non-allowlisted workflows are refused with an ephemeral message and start nothing
- [ ] Invalid or stale Slack signatures return 401
- [ ] The run's thread root, approvals and exactly one final result message appear in the same thread
- [ ] Final-result posting is idempotent across notifier ticks and restarts (`run-result:<id>` dedupe key plus `result_posted_at`)
- [ ] Command text is never used as a command, shell string, tool name or version; inputs are bounded strings
- [ ] Unknown duration or error prints "unavailable", never a guess
- [ ] Audit events recorded for start and settings changes
- [ ] Settings API and UI panel work; `docs/slack-runs.md` added
- [ ] `npm run typecheck` and `npm run test:local` pass; no regressions in approvals tests

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order, each validation passed
- [ ] Typecheck and full local suite pass
- [ ] Settings UI verified in the browser (screenshot saved)
- [ ] Manual fake-Slack flow confirmed
- [ ] Acceptance criteria met
- [ ] Committed on `dev` with `feat:` messages (no merge, close or force-push)

---

## NOTES

- **Decision, thread root**: the slash-command reply itself has no `ts`, so we post a real message to get a thread root. This costs one extra post but makes the thread durable and addressable by `chat.postMessage`.
- **Decision, notifier vs outbox**: a polling notifier (like alerts) was chosen over a new outbox kind because run completion is written by Temporal activities (`recordRun`) in several places; polling `runs` for terminal states avoids touching the interpreter and stays crash-safe.
- **Decision, allowlist default**: empty allowlist means nothing can be started from Slack (deny by default).
- **Open question for the user**: should intermediate status (per-step progress) be posted, or only approvals and the final result? The plan does the latter to keep Slack quiet.
- **Open question**: is a single global command channel enough, or should the thread be created in the channel where the command was typed? The plan uses the channel override if set, otherwise the invoking channel.
- **Later**: `app_mention` and `/azhi status|cancel` reuse the same user-link, allowlist and thread table.

**Confidence for one-pass success**: 7/10. Main risks: workspace resolution from a signed slash command (no run id to key on), Slack's 3-second limit around `startRun` (plan building and preflight can be slow), and where the notifier is wired in `server.ts` (not yet read).
