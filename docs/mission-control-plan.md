# Mission control: the Azhi Flow web app

Status: increments 1 to 4 and the visual editor built on branch `mission-control`
(2026-10-04/05). Suresh picked Operations as increment 2. Increment 4 (team and channels) built 2026-10-05. Written 2026-10-04. Owner: Suresh.

## Goal

Today the web UI is one read-only page per run (`azhi open <run>`). Everything else (starting runs,
approvals, schedules, secrets, workers, datasets) needs the CLI. Mission control is the web app an
operator keeps open all day: it answers "what is running, what is stuck, what needs me, what did
it cost, and can I trust it" in one place, and lets them act without a terminal.

It is also the base for the paid product: the hosted web app and the desktop window (Tauri or
Electron around `azhi up`) both show this same app.

## Principles

1. **Same API, same rules.** The UI is a client of `/v1` like the CLI. Every write (start a run,
   approve, cancel, set a secret, change a schedule) goes through the existing endpoint, so role
   checks, the run plan, the decision schema and the audit log apply unchanged. No UI-only
   back doors.
2. **Secrets are write-only.** The UI shows a secret's name, version and when it changed, and can
   set a new value. It never receives a value; the API has no endpoint that returns one to a user.
3. **Trust is visible.** Run plan blockers, policy coverage, taint, signature status and
   `outcome_unknown` writes are shown where decisions are made, not buried in a run page.
4. **Unknown is not zero.** Cost and usage keep the spec's rule: missing usage shows as unknown.
5. **Same auth.** Owner/API token (and OIDC bearer tokens) as today. The token is held in the tab
   (sessionStorage), passed once in the URL fragment by `azhi open`, never in a URL the server
   logs. Strict CSP, no third-party scripts or fonts.

## Screens

| Screen | Shows | Actions |
|---|---|---|
| **Overview** (mission control) | Runs now: running, waiting, queued. Last 24 h: succeeded, failed, delivery failed. Approvals waiting on you. Workers online. Model spend today and 7 days. Alerts. Next scheduled runs. Recent runs. | Jump to anything below |
| **Runs** | All runs, filter by state, workflow, input text and date, paged | Open or cancel a run |
| **Run** | Today's run page: graph, timeline, ledger, policy coverage, context manifest, usage, live over SSE | Cancel; approve or reject a waiting approval in place |
| **Approvals** | Every approval waiting for a decision: workflow, run, message, payload, who may decide, expiry | Approve (with decision data from the schema) or reject |
| **Workflows** | Each workflow: latest and published version, signed or not, schedule, last run | Open |
| **Workflow** | Versions; the run plan for the latest published version (blockers, requirements, coverage); input schema; recent runs | Start a run with a form built from the input schema (refused if the plan has blockers, as in the API); test run |
| **Schedules** | Cron, timezone, next occurrence, enabled, last occurrence's run | Enable or disable |
| **Workers** | Name, online/offline, last heartbeat, task queue, capabilities, trust policy | — |
| **Secrets** | Name, version, last changed (never values) | Set a new value (write-only) |
| **Datasets** | Name, trusted, published revision, tags, documents | Create; add and revoke documents; publish a revision |
| **Tools** | Tool catalog: id, version, effect, trusted output | — |
| **Usage** | Spend and tokens by day and by workflow, with completeness | — |
| **Audit** | Audit log: who changed secrets, published, approved, changed schedules or trust policies | — |
| **Health** | `azhi doctor` checks: database, Temporal, interpreter builds, workers | — |

### Alerts

Computed by the server from state it already has (no new subsystem):

- runs that failed or ended `delivery_failed` in the last 24 h;
- ledger writes in `outcome_unknown` (need a human to confirm);
- approvals that expire within an hour;
- no worker online, or a worker offline while runs wait on it (`worker_offline`);
- scheduled workflows whose current run plan has blockers (the next occurrence will be refused);
- runs waiting longer than their expected time.

The scheduler role checks once a minute, records every alert in `alert_state` (first seen,
last seen, cleared) and posts each new alert once to the workspace's Slack channel
(`PUT /v1/settings/alerts`, admin), with the same `slack-bot-token` secret workflows use. These
posts are platform notifications, not workflow writes, so they are audited (`alert.sent`) but
not in any run's action ledger. A Slack failure is kept on the alert and retried next pass.

### Spend limits

A limit (`PUT /v1/budgets`, admin, audited) applies to one workflow or the whole workspace, per
UTC day or month. Spend is measured model cost; unpriced turns are not counted, so it is a lower
bound. Once a limit is used up, the run plan of every workflow with agent steps under it gets a
`budget_exceeded` blocker: API and web runs are refused, and scheduled occurrences are skipped
and audited (`schedule.occurrence_refused`) instead of retried. Test runs still work. Alerts
fire at 80% and at 100%.

## New API endpoints

All read endpoints are workspace-scoped and need a user token; writes reuse existing endpoints.

- `GET /v1/overview`: counts, spend, pending approvals count, workers online, next schedules.
- `GET /v1/alerts`: the list above.
- `GET /v1/approvals?state=pending`: waiting approvals across runs, with the node's role,
  decision schema, message, payload and expiry. Deciding still uses `POST /v1/runs/:id/approvals`.
- `GET /v1/runs?state=&workflow=&before=`: filters and paging on the existing list.
- `GET /v1/usage/summary?days=`: spend and tokens by day and workflow.
- `GET /v1/audit?limit=&before=`: audit events (role admin).
- `GET /v1/alerts/history`, `GET|PUT /v1/settings/alerts`, `POST /v1/settings/alerts/test`.
- `GET|PUT /v1/budgets`, `DELETE /v1/budgets/:id`.
- `PATCH /v1/schedules/:id`: enable or disable (admin, audited).
- `GET /v1/workflows` gains schedule, signature and last-run columns.

## Technology

The spec (section 6) names React, Vite and TanStack Query for the web app, with React Flow and
Monaco in the first release. Mission control follows it:

- `web/` holds a Vite + React + TypeScript app; `npm run build:web` writes `src/web/dist/`, which
  the server serves at `/ui` with the same strict CSP. The Docker image builds it.
- TanStack Query polls the summary endpoints (every few seconds) and the run page keeps its SSE
  stream with Last-Event-ID resume.
- No component library; a small set of our own components and CSS variables (light and dark),
  so the bundle stays small and the CSP stays strict.
- Playwright tests in `test/web.test.ts` drive the built app in the pre-installed Chromium.

## Increments

1. **Mission control read side + the two most common actions.** Overview, runs, run page
   (ported), approvals inbox with approve/reject, workflows with run plan and "start run" form,
   schedules, workers, secrets (names and set value), health. New endpoints above.
2. **Operations** (built). Usage and cost dashboard, audit log, alerts with history and Slack
   delivery, spend limits, tools and datasets views, run again with the same inputs.
3. **Authoring** (built 2026-10-05). Upload a package folder from the browser
   (`/ui/workflows/upload`, filtered like `azhi publish`, saved as an unsigned draft with the
   compiler's findings shown when it is refused); the files of each version (read-only viewer);
   publish a signed draft (unsigned drafts point to `azhi publish`, since the browser holds no
   publisher key); a workflow's schedule (cron, timezone, inputs, on/off; admin); datasets
   (create, add Markdown or text documents, publish a revision with a tag, revoke a document;
   `GET /v1/datasets/:name` honours the dataset ACL); tools (register, or change one as a new
   revision; admin). All writes are the existing endpoints.
4. **Team and channels** (built 2026-10-05). Browser sign-in with OIDC: authorization code with
   PKCE, exchanged by the server (`/v1/auth/login`, `/v1/auth/callback`; verifier, state and nonce
   in a signed 10-minute cookie scoped to `/v1/auth`), handing the issuer's JWT to the tab in the
   URL fragment like `azhi open`, so the server keeps no sessions. Users page (admin): invite by
   email (claimed on first sign-in with a verified email, with the given role), change roles,
   disable, issue and revoke API tokens, link a Slack user; nobody changes their own role, the
   owner is never changed, and only the owner makes or changes admins (migration
   `0004_team.sql`). Slack approval buttons: with an approvals channel set (Approvals page),
   each waiting approval is posted once with Approve and Reject buttons; clicks arrive at
   `/v1/slack/interactions`, are verified with the `slack-signing-secret` secret, and count only
   for a linked, enabled user, through the same role, schema and first-decision checks as the
   API (`src/server/approvals.ts`).
5. **Visual editor** (React Flow). Step 1 built (2026-10-05, asked for by Suresh): the read-only
   workflow canvas (`web/src/components/WorkflowCanvas.tsx`) on the workflow and run pages, with
   live node states, approval gates, condition routes and node details, and the SDLC example
   (`examples/sdlc`) to show it. Step 2 built (2026-10-05): the workflow editor
   (`web/src/pages/Editor.tsx`, `/ui/workflows/:slug/edit`). Steps are added from a palette,
   linked by dragging between cards (or the "Runs after" list), changed in a side form (structured
   values as YAML), renamed with every reference, and removed. Each change is checked by the
   server (`POST /v1/versions/:ref/check`: compiler diagnostics on the cards, and the run plan the
   edit would have). "Save draft" (`POST /v1/versions/:ref/drafts`, author) writes the definition
   back as the package's workflow file next to its other files, unchanged, through the normal
   package upload, so it is audited and becomes a new unsigned draft of the same workflow; the
   workflow id cannot change. YAML comments inside the file are not kept (the opening comment
   block is). Publishing still needs a publisher signature (`azhi publish`); signing in the
   browser is a later decision. `GET /v1/versions/:ref/source` returns the package's text files
   (the start of the definition viewer).

Smaller additions (2026-10-05): cancel a run from the runs list (operator), search runs by text
in their inputs or the start of the run id and by date (`GET /v1/runs?q=&since=&before=`), and a
theme switch (system, light, dark; kept in the browser).

   Step 3 built (2026-10-05): the **harness builder**, a panel on every agent step. It lists the
   executors the server declares (`GET /v1/executors`, with what each enforces), edits the step's
   profile (provider, model, key secret, instructions, temperature, turn and token limits) and can
   create a new `name@version` profile, picks tools from the registry, and sets datasets and the
   budget. Profiles travel with the draft: `check` and `drafts` take an optional `profiles` map
   (`profiles/<name>@<n>.yaml` to YAML text, validated with the same parser as the compiler).
   Not yet: trying a step on one input from the browser (use `azhi test-node`).

## Out of scope for now

Billing, multi-workspace switching, and a hosted control plane. Those belong to the "sell it"
decision (hosted web first was recommended) and come after increment 4.
