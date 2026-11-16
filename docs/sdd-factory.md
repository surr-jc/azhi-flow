# SDD Factory

A spec-driven delivery of a whole release in one run. A person gives it a goal (or a ticket) for a GitHub repository and
a base branch. It asks questions with a recommendation each, writes a release plan, splits it into Stories, and
delivers the Stories one after another into a stack of pull requests, each reviewed and signed off by a person. It is
built from workflows that already exist; three are new. The Stories are GitHub issues (`source: github`) or, with no
tracker at all, live in the run and in the first pull request (`source: files`, see "No tracker" below).

| Workflow | What it does | Status |
|---|---|---|
| `sdd-factory` | the orchestrator: plan, split, ask once, deliver every Story in order, check the release, summarize | new |
| `sdd-story` | one Story to a signed-off pull request: an OpenSpec change, a build with tests, a review, one fix round, a sign-off | new |
| `sdd-breakdown` | splits an epic into Stories and returns them as data; writes nothing (`source: files`) | new |
| `issue-splitter` | splits an epic into Stories (GitHub issues) (`source: github`) | existing |
| `pr-review` | reviews one pull request with four reviewers and a verifier | existing, new `diff_base` input |
| `ai-sdlc-factory-verify` | checks the release's journeys and invariants against a branch | existing, new `propose_fix` input |

```
plan      goal/ticket ─ brief ─ brainstorm ─ person ─ plan_release ─ person ─ epics
split                                                                      └─ github: split_epics: issue-splitter × epics (≤ 3)
                                                                               files:  breakdown_epics: sdd-breakdown × epics (≤ 3)
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

**3. Ask once.** `autonomy` lists the Stories and the base branch and asks which mode to run them in. Rejecting it
stops the run with nothing delivered. The plan and the tickets have already been approved by a person at this point, in
either mode.

- `supervised` (the default, and what an empty choice means): a person approves the specs of each Story and signs each
  one off.
- `auto`: no person is asked at those two points when the rules say it is safe, the agents' recommendations are taken
  for open questions, and every such decision is posted to Slack. Anything doubtful still asks a person, as in
  supervised, and the message says why it asked. See "Auto mode" below.

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
azhi example install sdd-breakdown --repo OWNER/REPO --set slack_channel=C0123ABCD   # only for source=files
azhi example install sdd-factory --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi run examples/sdd-factory --input source=github --input repo=OWNER/REPO --input base_branch=dev --input goal="..."
```

Sign and publish each draft, children first: the factory resolves each child when its step starts. A child that is not
published stops the run there (`issue-splitter` for `source=github`, `sdd-breakdown` for `source=files`). `pr-review` needs the OpenCode sign-in and tokens described in [pr-review](pr-review.md).

## No tracker (`source: files`)

`source=files` runs without any tracker: no issue is read or created, and the run needs a `goal` (a ticket is refused).
Everything else is the same run. The differences:

- **Split.** Each epic goes through the published `sdd-breakdown` instead of `issue-splitter` (a `tracker_gate` after
  `has_epics` picks the loop). It sizes the epic against the code, a person approves its plan, and it returns the
  Stories as data (a slice number, a one-line title, a Markdown body); it creates nothing. An epic that is not a code
  change, or whose slices were all left out, gives no Story and does not stop the run. A breakdown that fails, ends
  without its `stories` step (a rejected plan) or returns more than 6 Stories for an epic stops the run before any
  Story is delivered, like a splitter that fails.
- **Names.** The `release` step makes an id from the plan's title and six random hex characters. They are random, not a hash
  of the goal, so two runs of the same goal on the same repository never push over each other's branches; a resumed run
  keeps its names because a step that succeeded is not run again. The Stories
  are numbered 1..N across the release (epics in plan order, then slice order) and named `<release>-sN`. A Story's
  branch is `azhi/<release>-sN`. The summary and the approval show that key where `files` has no issue number.
- **The breakdown file.** `breakdown_doc` writes `docs/release/<release>/breakdown.md`: the plan and every Story with
  its epic and body (the plan cut to 30000 characters, each body to 3000, the file to 60000). It is committed in the
  first Story's pull request only (`extra_files` of the first `sdd-story` run), so a person reviews the plan next to
  the first change. Later Stories do not carry it.
- **Each Story** is a run of `sdd-story` with `source: files`: the Story's key, title and body are inputs instead of a
  ticket.
- **The autonomy question** lists each Story's key, title and epic (the bodies are not put in the approval), and says that
  the plan is committed in the first pull request.
- **Limits.** At most 3 epics of 6 Stories, so 18 Stories: the 20-Story refusal exists but a files release cannot reach it.
  The Story's title is cleaned to one line and its body of control characters before they reach a child or a file; they
  are text from an agent and appear only inside the breakdown file and the child's inputs.

## Auto mode

Questions always come with a recommendation: the brainstorm questions and the spec author's open questions each carry the
answer the agent would take if nobody answers. In `supervised` a person can leave an answer empty to take it; in `auto`
the rules below decide whether it may be taken without asking.

A Story in `auto` asks a person exactly when a rule says it must:

| Gate | Goes ahead without a person only if |
|---|---|
| specs approval | the spec reviewer approved with no blocking finding and saw no prompt injection; the automatic check passed; there are no conflicts with other changes; every open question has a recommendation (at most 10) |
| sign-off | the tests passed; the review itself approved (a fix round after a review that asked for changes does not count, because nobody reviewed the fix); the verifier found nothing critical and neither it nor the spec reviewer saw a prompt injection; the pull request is not a draft; no finding is left for a hand check |

Every decision taken this way is posted to Slack with the ticket, what was decided and why, and the sign-off message says
plainly that nobody signed it off. A Story whose review asked for changes still gets its one fix round, but then a person
signs it off, with the reason in the approval message. A failed test, a failed review or a rejected approval still sends
the Story back, and a Story that is sent back still stops the loop.

## A new product (greenfield)

Create the repository yourself with one commit on the base branch, such as a README, and start the factory on it. The
brainstorm reads the checkout, and when it finds no source code (only a README, a licence, an ignore file or CI
templates) it sets `greenfield`. You see that in the approval message and can say it is wrong. In a greenfield
repository:

- the brainstorm spends its questions on what the code cannot answer, each with a recommendation: the language and
  framework, the shape of the application, storage and deployment, test tooling and what CI must run
- the first Story of the first epic that is split (epic 1, unless you left it out) is a runnable scaffold: the project
  layout for the chosen stack, one passing test, a CI workflow that runs it, a README with the run and test commands,
  and `.azhi/commands.json` with the install, typecheck, test and build commands
- the later Stories stack on that scaffold like any others

The scaffold carries `.azhi/commands.json` because the delivery runs the repository's own commands on every Story and a
fresh repository has no history to detect them from.

What is covered: the flag, the questions, the planner's instruction and the line added to the first epic are wired and
tested. What is not: whether the agents follow the instruction, or whether a real scaffold passes the delivery's test
gate. Treat the first greenfield run as a trial of those two.

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

- **Jira.**
- **A repository with no commit at all**: each push is a commit onto a base commit, and the brainstorm clones the base
  branch, so create the repository with one commit (a README is enough). See "A new product" above.
- **Order between epics** is the plan's order; only the Stories inside an epic have dependencies.

## Verification

`test/sdd-story.test.ts`, `test/sdd-breakdown.test.ts` and `test/sdd-factory.test.ts` compile the packages with their
tools, check that every write has a gate, and run every script on fixtures including the cases that fail closed. Each
script's output is also checked against the schema its package declares for it, because the engine refuses an output its
schema does not allow. `test/sdd-story-e2e.test.ts`, `test/sdd-breakdown-e2e.test.ts` and `test/sdd-factory-e2e.test.ts`
run the packages' own graphs on the engine. None of them runs the agents: the checkout agents of `sdd-story` and
`sdd-breakdown` are replaced by scripts, the brainstorm and planning agents of the factory by scripted answers, and the
children of each are stand-ins. So these tests cover the wiring (routes, joins, ordering, stacking, stopping, the
summary), not what the agents write, the real test gate on a repository, or a run against GitHub and Slack.

`test/sdd-contracts.test.ts` covers the seams the stand-ins hide. It runs the real scripts of one package on the real
output of another (what `sdd-breakdown` returns, through the factory's outcome, order and document scripts, to the inputs
`sdd-story` declares), and checks every child call in the compiled plans against the child's declared inputs.

One engine rule matters when editing these workflows. A loop's round gate runs unless every step of that round was
skipped, and the compiler counts any step an exit rule reads as one of its dependencies. An exit rule that reads a step
outside the loop therefore makes the gate of a round that never started run, and the run fails. All three loops here
(`split_epics`, `breakdown_epics`, `deliver_stories`) read only their own steps (`last` is computed inside the round),
and a unit test checks it. The `order` and `summary` steps read the loops only behind `has()` and are `merge: any`
joins, because a step that reads a skipped step is skipped; `summary` does not list `breakdown_epics`, since a run
cannot end inside it (`order` always follows and `has_stories` reaches the summary).
