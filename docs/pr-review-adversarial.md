# Adversarial pull request review

`examples/pr-review-adversarial` reviews one GitHub pull request against **what it was supposed to do**, and then
**attacks it**. Give it a repository, a pull request number and, optionally, the requirement: a GitHub issue, a Jira
ticket, or text you type. It is the sibling of [pr-review](pr-review.md) (static reviewers, a verifier, a comment) and
builds on the `adversarial-pr-review` skill of [tomzx/agents](https://github.com/tomzx/agents) (MIT): assume the change
is broken, map the attack surface, rank the failure scenarios, try the best ones, and say what was reproduced.

It only reads and comments. It has no merge, push, close or approval step.

```
pr ─ should_review ─┬─ source ─┬─ jira_issue ─ intake_jira ──┐
                    │          ├─ github_issue ─ intake_github ─┼─ ticket ─ requirements ─┬─ conformance ─┐
                    │          ├─ text_pass ─────────────────────┤                          └─ surface ─ should_probe ─ probe ─ probe_results ─┐
                    │          └─ inferred_pass ─────────────────┘                                                                                ├─ verify ─ triage ─ summarize ─ review ─┬─ post (PR comment)
                    └─ static ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘                                        └─ notify (Slack)
```

## Run it

```bash
azhi example install pr-review-adversarial --repo OWNER/REPO --set slack_channel=C0123ABCD --set probe_setup_command="npm ci"
azhi run examples/pr-review-adversarial -i repo=OWNER/REPO -i pr=123 -i issue=PAY-142              # a Jira ticket
azhi run examples/pr-review-adversarial -i repo=OWNER/REPO -i pr=123 -i issue=45                   # a GitHub issue (45, owner/name#45 or a URL)
azhi run examples/pr-review-adversarial -i repo=OWNER/REPO -i pr=123 -i requirement="Retry a failed payment 3 times, then give up" -i post=false
```

| Input | Meaning |
|---|---|
| `repo`, `pr` | Required. The pull request under review. |
| `issue` | A GitHub issue (`45`, `owner/name#45`, an issue URL) or a Jira key (`PAY-142`). Wins over `requirement`. |
| `requirement` | The goal as text (up to 20,000 characters). Used when no issue is given. |
| *(neither)* | The PR title and description stand in for the requirement, marked **inferred**: gaps against it are advisory and never turn the light red. |
| `post` | `false` is a dry run: nothing is posted or sent. |
| `allow_closed`, `diff_base` | As in `pr-review`: review a closed PR anyway; review a stacked PR from the commit its own work starts at. |

Secrets: `github-read-token` (read-only Contents, Issues, Pull requests), `github-comment-token` (Pull requests: write,
used only by the comment), `jira-api-token` (only for a Jira key; needs the `jira_url` and `jira_username` settings and
`uvx` on the gateway), `github-copilot-token` (`azhi copilot login`), `slack-bot-token` (optional).

## What each step does

| Node | What it does |
|---|---|
| `ticket` | One plain ticket from the issue, the text, or the PR description (`scripts/ticket.py`). Capped, and passed on as data. |
| `requirements` | Agent: numbered, testable acceptance criteria `R1..Rn` and the open questions. Invents nothing. |
| `conformance` | Agent in a read-only checkout: each criterion is `met`, `partial`, `missing` or `unverifiable`, with `file:line`; unrequested behaviour changes become findings. |
| `static` | One read-only pass for correctness and security, so cheap findings are not lost. |
| `surface` | Agent: the attack surface (entry points, invariants, trust boundaries, state, contracts, callers), candidates over the eight failure classes, ranked by likelihood x impact, 3 to 5 selected (one high impact), the rest listed as deferred. |
| `probe` | Agent in a **writable** checkout: writes one small probe per scenario under `.azhi-probes/`, or walks the ones that cannot be executed (deployment, anything needing a service or credential). |
| `probe_results` | Script: what the runner printed becomes one result per scenario. |
| `verify` | A different model family tries to refute every finding **and every reproduced failure**, including whether the probe was an artefact. |
| `triage` | Script: the verdict, the severities, the requirement coverage and the light. No model. |
| `summarize` | Agent without a checkout: a plain summary and next steps. It cannot change a fact. |
| `review` | A template over the decided facts: the run artifact and the PR comment (sticky: a later run edits it). |

## How probes run, and what they can do

The agents have no shell (`bash` is denied for every OpenCode step). A probe is a file the agent writes; the **worker**
runs it after the agent submits, as the step's workspace test command:

1. The `probe_setup_command` setting (default `node --version`; use `npm ci`, `pip install -e .`, and so on). If it
   fails, nothing runs and every executed scenario is **unproven**.
2. `scripts/probe-runner.cjs`, compressed into the workflow (`scripts/build_probe_command.mjs`; run
   `scripts/sync_probe_command.mjs` after editing the runner, and the test fails if they differ). It runs each
   `.azhi-probes/<id>/probe.json` (`argv`, no shell) with 10 minutes per probe and 25 in all, and records the probe's
   last stdout line: `REPRODUCED: ...` or `HELD: ...`. Anything else is `not_run` with the reason (crash, timeout,
   program missing). It always exits 0.

The runner's lines, not the agent's claims, decide. A change anywhere outside `.azhi-probes/` voids every probe.

Be clear about the safety boundary: the command runs repository code, written by an agent, **on the worker** with a
scrubbed environment (no secrets, `CI=true`), in a throwaway checkout whose git directory is out of reach, and the
checkout is deleted afterwards. There is no OS sandbox and no network block: the rules "no network, no live
credentials, no destructive operation" are in the agent's instructions and the runner's limits, not enforced by the
kernel. Run it on a worker you would trust as a CI runner for that repository.

## The verdict

Adversarial verdict (the skill's):

| Verdict | When |
|---|---|
| **breaks** | a failure was reproduced **and** the refuter confirmed it at `min_confidence` (80) or more |
| **unproven** | nothing reproduced and a decisive scenario was not executed, or no probe executed and passed (ruling out by reading alone does not carry a pass), or nothing was selected |
| **holds** | a probe executed and passed, and nothing decisive is unproven. *Not proof the change is correct.* A diff with no executable surface also holds, and says so |

A reproduced failure the refuter refutes or cannot confirm becomes unproven: the probe may be wrong. Reproduced
failures are graded `MUST` (data loss, trust-boundary bypass, outage, a wrong access or money decision), `SHOULD`
or `MAY`, from the refuter's grade or the scenario's impact. Evidence is labelled `L2 - Ruled out`,
`L3 - Executed` or `L4 - Reproduced` (a CLI or HTTP surface driven end to end).

Overall light, which is what the comment and Slack lead with: **red** (no-go) when it breaks, a blocker survived, or a
requirement is missing; **yellow** when it is unproven, a major finding survived, a requirement is partial or not
verifiable, something needs a manual check, or a probe was voided; **green** otherwise. An unverifiable or
unassessed criterion is never counted as met.

## Untrusted text

Ticket, issue, PR and repository text are data. Every profile says so, no agent has a shell or a network tool, no text
from them becomes a command, shell string or tool name (the probe `argv` is checked by the runner and runs without a
shell), the comment may only go to the PR under review (CEL guard), and Slack only to the configured channel. Text
shown in the comment from findings and probes has backticks and `@` neutralised; the summary and next steps are written
by a model and are the one part of the comment that is not.

## Limits

- Up to 5 scenarios and 15 criteria per run.
- The Jira path needs `uvx mcp-atlassian` on the gateway; without it, give the requirement as text or a GitHub issue.
- Probes cost a worker for up to 35 minutes; set `post=false` for a dry run while tuning `probe_setup_command`.
- A toolchain the checkout cannot install makes the affected scenarios **unproven**, never a pass.
