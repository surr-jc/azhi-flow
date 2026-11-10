# SDD Factory

A spec-driven delivery of a whole release in one run. A person gives it a goal (or a ticket) for a GitHub repository and
a base branch. It asks questions with a recommendation each, writes a release plan, splits it into Stories, and
delivers the Stories one after another into a stack of pull requests, each reviewed and signed off by a person. It is
built from workflows that already exist; two are new.

| Workflow | What it does | Status |
|---|---|---|
| `sdd-factory` | the orchestrator: plan, split, ask once, deliver every Story in order, check the release, summarize | new |
| `sdd-story` | one Story to a signed-off pull request: an OpenSpec change, a build with tests, a review, one fix round, a sign-off | new |
| `issue-splitter` | splits an epic into Stories (GitHub issues) | existing |
| `pr-review` | reviews one pull request with four reviewers and a verifier | existing, new `diff_base` input |
| `ai-sdlc-factory-verify` | checks the release's journeys and invariants against a branch | existing, new `propose_fix` input |

```
plan      goal/ticket ─ brief ─ brainstorm ─ person ─ plan_release ─ person ─ epics
split                                                                      └─ split_epics: issue-splitter × epics (≤ 3)
ask                                                                           └─ order ─ autonomy (person)
deliver                                                                          └─ deliver_stories: sdd-story × Stories (≤ 20)
end                                                                                  └─ release_check ─ summary ─ Slack
sdd-story  ticket ─ specs ─ person ─ build + tests ─ archive ─ push ─ pull request ─ pr-review ─ [fix] ─ person ─ label
```

## The run, step by step

**1. Plan.** The first half is `ai-sdlc-factory-plan`: a brainstorm with up to five questions and two or three
approaches (one recommended) that a person answers, then a release plan (problem, goals, invariants, user journeys, up
to three epics) that a person approves. The person may leave epics out.

**2. Split.** Each remaining epic goes through the published `issue-splitter`, one after the other, each with its own
approval. A split epic returns its sub-issues; an epic that fits one pull request returns one issue. The `order` step
lists the Stories: epics in plan order, then each epic's Stories in the order the splitter created them. If any
splitter fails, or the plan has more than 20 Stories, nothing is delivered and the summary says why.

**3. Ask once.** `autonomy` lists the Stories and the base branch. Rejecting it stops the run with nothing delivered.
Only the `supervised` mode exists: see the end of this page.

**4. Deliver.** `deliver_stories` runs `sdd-story` for each Story, in order. The first Story is cut from the base
branch; each later one from the branch the previous Story left (`stack_on`). Every pull request still targets the base
branch. A Story is stacked on a branch only if it was signed off and the branch is one of Azhi's (`azhi/...`). A Story
that is sent back, fails or expires stops the loop; the Stories after it are not started.

**5. One Story** (`sdd-story`, a copy of `openspec-flow` with another ending):

1. an OpenSpec change (proposal, delta specs, tasks), checked by a script, with one fix round; a person approves it
2. the tasks are built with tests, using the repository's own test command (as `sdlc-universal` finds it); if none can
   be found, the Story is sent back
3. the change is verified against its specs and archived, and a script checks the archive
4. one `azhi/` branch is pushed and a pull request opened into the base branch (a draft if the verifier found a
   critical issue)
5. `pr-review` reviews the pull request as a child run, from the commit the branch was cut from (`diff_base`), so a
   stacked pull request is reviewed on its own changes. It never offers to merge
6. findings the review triaged as fix-now get one fix round: the tests must pass, then the same branch is pushed again.
   The fix is not reviewed again, and the sign-off says so
7. a person signs the pull request off, seeing the tests, the review, what remains and the verifier's report; the
   ticket gets the `sdd-signed-off` label

**6. End.** If every Story is signed off and the plan has journeys or invariants, `ai-sdlc-factory-verify` checks the
top branch of the stack against them (`propose_fix` off, so it asks for no ticket). The summary lists each Story with its
result, the pull requests in the order to merge them, and the release check: `verified`, `failed`, `unavailable` or
`skipped`. It is posted to Slack whichever way the run ended.

## Install and run

```bash
azhi example install issue-splitter --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi example install pr-review --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi example install ai-sdlc-factory-verify --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi example install sdd-story --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi example install sdd-factory --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi run examples/sdd-factory --input source=github --input repo=OWNER/REPO --input base_branch=dev --input goal="..."
```

Sign and publish each draft, children first: the factory resolves each child when its step starts. A child that is not
published stops the run there. `pr-review` needs the OpenCode sign-in and tokens described in [pr-review](pr-review.md).

## Limits and rules

- **Nothing merges, closes or force-pushes.** A person merges the pull requests, in the order the summary gives, and
  closes each Story's issue (GitHub only closes an issue on a merge into the default branch).
- **Stacked pull requests show earlier work.** Until the earlier ones merge, a pull request's page on GitHub shows the
  changes of every Story below it. The review does not: it starts at `diff_base`.
- **At most 3 epics and 20 Stories** per run (the splitter makes up to 6 Stories per epic, and a loop has at most 20
  rounds). A larger release is two runs.
- **A Story child lives up to 7 days** (`timeout: 168h` on the step) so two 72-hour approvals fit. A subworkflow step
  defaults to one hour, and the child is ended at the step's timeout plus a minute, even while it waits for a person.
- **Ticket, issue and pull request text is data.** The factory builds each Story's reference from the repository and an
  issue number, never from a title; titles are cut and cleaned before they reach Slack.
- **Unknown stays unknown.** A child that failed, a verdict that cannot be read or a release check that did not run is
  `unavailable`, never `verified`.

## Not built yet

- **An unattended mode** where agents answer their own questions with their recommendation, with each decision posted to
  Slack. `sdd-story` accepts `mode: auto` and the factory's `mode` step is the one place that would change, but nothing
  routes on it yet.
- **Jira** and a **tracker-free mode** that keeps the breakdown as files in the repository.
- **Greenfield**: the factory reads the repository for its brainstorm and each push needs a base commit, so an empty
  repository without any commit does not work.
- **Order between epics** is the plan's order; only the Stories inside an epic have dependencies.

## Verification

`test/sdd-story.test.ts` and `test/sdd-factory.test.ts` compile both packages with their tools, check that every write
has a gate, and run every script on fixtures including the cases that fail closed. `test/sdd-story-e2e.test.ts` and
`test/sdd-factory-e2e.test.ts` run the packages' own graphs on the engine. Neither runs the agents: the checkout agents
of `sdd-story` are replaced by scripts, the brainstorm and planning agents of the factory by scripted answers, and the
children of each are stand-ins. So these tests cover the wiring (routes, joins, ordering, stacking, stopping, the
summary), not what the agents write, the real test gate on a repository, or a run against GitHub and Slack.

One engine rule matters when editing these workflows. A loop's round gate runs unless every step of that round was
skipped, and the compiler counts any step an exit rule reads as one of its dependencies. An exit rule that reads a step
outside the loop therefore makes the gate of a round that never started run, and the run fails. Both loops here read
only their own steps (`last` is computed inside the round), and a unit test checks it.
