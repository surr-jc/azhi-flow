# AI SDLC Factory

Three workflows that run the delivery loop of a "software factory" on top of what Azhi already has: plan a release
with a person, split it into dependency-ordered tickets, let a scheduled lap deliver one ticket at a time into a pull
request on a staging branch, and grade the repository's readiness so a broken CI is noticed and proposed as a ticket.
Tickets come from **Jira or GitHub**; the code, CI and pull requests are always on GitHub.

The shape follows Cole Medin's software factory (his video on wrapping a factory with Port, and
<https://github.com/coleam00/ai-software-factory>), adapted to Azhi's rules: **nothing merges, closes or force-pushes**,
every write sits behind a gate, and ticket text is data.

| Workflow | What it does | Trigger |
|---|---|---|
| `ai-sdlc-factory-plan` | a release plan (PRD) with a person, then tickets with their order | manual |
| `ai-sdlc-factory` | one lap: pick, claim, deliver one ticket into a pull request, report | schedule |
| `ai-sdlc-factory-readiness` | bronze, silver or gold scorecard; proposes a fix ticket when CI is red | schedule |

```
plan       ticket/goal ─ brief ─ plan_release (agent) ─ prd_review (a person) ─ epics ─ issue-splitter / issue-splitter-jira  × up to 3 epics
                                                                                                │
                                                          tickets: Slice N of M, Depends on slice, labels ready / azhi-split
                                                                                                ▼
lap        source ─ queue (GitHub: ready + azhi-split, or Jira: JQL) ─ pick ─ has_work ─┬ idle ─ idle_report
           (cron)                                                       (rules)         └ work ─ claim ─ deliver (sdlc-universal) ─ outcome ─┬ shipped ─ lap_report ─ Slack
                                                                                                                                                 └ sent back ─ owner label
                                                                          │
readiness  files + ci + open ticket ─ score (rules) ─ scorecard ─ Slack ─ (CI red, nothing open) ─ fix_approval (a person) ─ create fix ticket ─┘ next lap picks it first
```

## The loop, step by step

**1. Plan (`ai-sdlc-factory-plan`).** Give it a ticket (a Jira key, or `owner/name#42`), a goal typed as text, or both.
An agent (skill `release-prd`) reads the repository on the staging branch and writes the release plan: the problem,
goals and non-goals, the **invariants** the product must keep, the **user journeys** a tester walks, the owner (from
CODEOWNERS, or null when there is none), and up to three **epics**; the first makes the product runnable end to end. A
person approves the plan and may leave epics out. Each remaining epic then goes through the published
[issue splitter](issue-splitter.md) (GitHub or Jira), one after the other, each with its own approval. A splitter
makes up to six slices, so a release comes to about 10 to 18 tickets.

**2. A lap (`ai-sdlc-factory`).** Each run takes one ticket:

1. *Queue.* GitHub: the open issues labelled `ready` and `azhi-split` (`github.factory-queue`, which also reads each
   slice's order text and whether the earlier slices are closed). Jira: the JQL you set at install.
2. *Pick, by rules* (`scripts/pick.py`, no model). Never a ticket that is blocked, already claimed or in a pull request,
   done, or waiting for its owner. Then: priority first, then the ticket that unblocks the most other queued tickets,
   then the oldest. A dependency or status that cannot be read counts as blocking: the lap does less rather than start
   work out of order. An empty or fully blocked queue ends the lap quietly (no Slack message).
3. *Claim.* The ticket gets the `factory-in-progress` label, so the next lap skips it.
4. *Deliver.* The published [`sdlc-universal`](ai-sdlc.md) workflow does the work: readiness check, preflight, plan,
   build and test with the repository's own commands, one independent review, a release approval, then a pushed
   `azhi/` branch and a pull request into the **staging branch** (`staging_branch`).
5. *Outcome.* A pull request opened is reported. A delivery that ended without one (tests failed, nothing changed, a
   blocker) is reported and the ticket gets `factory-needs-owner`, so laps skip it until a person acts.

**3. Readiness (`ai-sdlc-factory-readiness`).** Rules grade the repository:

| Level | Needs |
|---|---|
| bronze | an owner (CODEOWNERS) and a README |
| silver | bronze, a pull request template and a CI workflow |
| gold | silver, and the latest completed CI run on the base branch passed |

A check that could not be read is `unavailable` and never counts as a pass: no CI runs is not a green CI. When CI is red
and no ticket is open for it (`ci-failing` label, or the JQL for Jira), a person approves, and one fix ticket is created
with the `ready`, `priority` and `ci-failing` labels. The next lap picks a `priority` ticket first, so a broken CI is
fixed before new work, with a person approving the ticket and again at the delivery's release approval.

## Install and run

```bash
azhi example install sdlc-universal --repo OWNER/REPO --set slack_channel=C0123ABCD   # the delivery, published
azhi example install issue-splitter --repo OWNER/REPO --set slack_channel=C0123ABCD    # Jira: issue-splitter-jira
azhi example install ai-sdlc-factory-plan --repo OWNER/REPO
azhi example install ai-sdlc-factory --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi example install ai-sdlc-factory-readiness --repo OWNER/REPO --set slack_channel=C0123ABCD
```

Sign and publish each draft, and publish the delivery and the splitter first: the plan and the lap run them as child
runs. The settings and secrets of each example are listed in its `azhi.config.yaml`; a GitHub-only install leaves the
Jira settings out. Then:

```bash
azhi run examples/ai-sdlc-factory-plan --input source=github --input repo=OWNER/REPO --input base_branch=dev --input goal="..."
azhi schedule ai-sdlc-factory-readiness --cron "0 7 * * *" --timezone Asia/Kolkata --input source=github --input repo=OWNER/REPO --input base_branch=dev
azhi schedule ai-sdlc-factory --cron "0 */2 * * *" --timezone Asia/Kolkata --input source=github --input repo=OWNER/REPO --input staging_branch=dev
```

Start with one lap you watch, and a long interval. A lap waits for the delivery's approvals, so laps overlap; the claim
label keeps two of them off the same ticket.

## What this does not do (yet)

- **No merge, no close.** A person merges each pull request into staging, batch-validates there, and sends what is
  wrong back as new tickets. GitHub does not close an issue when a pull request merges into a branch other than the
  default one, so a person **closes each slice's issue** after merging it: that is what releases the slices that depend
  on it. (When staging is the default branch, `Closes #N` in the pull request does it.)
- **A failed or rejected delivery cannot label its ticket.** A child run that does not succeed fails the lap, so the
  claim label stays and the ticket is skipped until a person removes it.
- **No event triggers.** Readiness runs on a schedule; a CI failure does not start it. Azhi has no webhook triggers yet.
- **Order is enforced inside an epic, not between epics.** The plan says when an epic needs another merged first.
- **No fan-out.** Azhi cannot loop agents or sub-workflows over a list, so each ticket is one scheduled run, not an
  iteration of one run.
- **Jira.** The Jira tools go through `mcp-atlassian`; the result shape of `jira_search` is read defensively, and an
  unreadable one makes the lap idle (never a guess). The delivery reads a Jira ticket through the workspace tool
  `jira-ccp_get_issue` (see `sdlc-universal`). Check both on a throwaway project first.

## Scaling the factory

The factory is one engineering loop. What Port adds around it, and where Azhi stands:

| Port's part | In Azhi today | Not built |
|---|---|---|
| Agent and skill registry (owners, versions, one copy per skill) | versioned agent profiles and skills inside each package, signed per publisher; profiles carry `owner`, `tier` and `platform` as comments | a registry across packages with owners, lifecycle and drift counts |
| Context lake (owners, readiness, Jira, Slack) | the plan reads the repository and CODEOWNERS; the lap reads Jira or GitHub; the scorecard reads the repository | a central, queryable layer over all repositories |
| Standards (scorecards) | the readiness workflow, with rules and `unavailable` for unknowns | one standard applied to many repositories, and grading each merge |
| Controls (approvals, self-improvement) | approvals before the plan is used, before a fix ticket and before a release; a red CI becomes a ticket that is picked first | event triggers; per-agent identity on commits |

## Verification

`test/ai-sdlc-factory.test.ts` compiles the three packages with their tools, checks that every write has a guard, and runs
the decision scripts on GitHub and Jira data: the pick order, the readiness level, the epics a splitter receives, and the
cases that fail closed. `test/github-issue-tools.test.ts` covers `github.factory-queue` and `github.repo-files`.
