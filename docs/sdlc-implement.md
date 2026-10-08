# Feature delivery to a pull request (OpenCode)

`examples/sdlc-implement` takes one ticket from intake to an opened pull request. It is the
`examples/sdlc` flow with agents that work in the real code: they read a checkout of the repository,
the build agent edits it, the worker runs the project's tests on the change, and after a person
approves the exact diff the gateway pushes an `azhi/` branch and opens a pull request.

`examples/sdlc` stays as it was: an analyze, plan and review pipeline whose agents have no tools and
whose CI result is fixture data. A run of it ends in a Slack message, never in code. Use this example
when the run should produce the change.

```
source ─┬─ jira_issue ──┐
        └─ github_issue ┴─ intake ─ requirements ─ design ─ design_review ─ build ─ code_review ─ quality_gate ─┬─ release_approval ─ push_branch ─ open_pr ─ release ─ retro
                                    (checkout)    (checkout)  (answers)    (writes,  (checkout                  └─ send_back
                                                                            tests)    + diff)
```

| Node | What it does |
|---|---|
| `source`, `jira_issue`, `github_issue`, `intake` | As in [sdlc.md](sdlc.md): the ticket from Jira (MCP) or GitHub, as one plain ticket |
| `requirements` | OpenCode in a read-only checkout, skill `requirements-brief`: problem, acceptance criteria, non-goals, evidence (`path:line`) and open questions, each with a recommended default |
| `design` | OpenCode in a read-only checkout, skill `implementation-plan`: 2-3 approaches and the recommended one, the files with the pattern to mirror (`path:line`), ordered tasks traced to criteria, test plan, risks, open questions, confidence |
| `design_review` | A person approves. The payload lists every open question, and the decision needs `answers` (one per question, or "use the recommended defaults"), so questions cannot be waved through. The build gets the answers |
| `build` | OpenCode in a **writable** checkout, skill `implement-change`. After it submits, the worker runs the test command; a failure goes back to the agent with the output, up to 3 attempts. The worker adds the real change to the output as `workspace` |
| `code_review` | OpenCode in a read-only checkout of the base, skill `fresh-eyes-review`, reviewing the diff against each acceptance criterion |
| `quality_gate` | `ship` only when the tests passed, the review approves and at least one file changed; otherwise `send_back` posts the reasons to Slack |
| `release_approval` | An admin approves the exact change: repository, branch, diff, stats, test result and review |
| `push_branch` | `github.push-branch@1`: one commit on the base commit, branch `azhi/<ticket key>` |
| `open_pr` | `github.create-pull-request@1` against the base branch (or the default branch) |
| `release`, `retro` | The pull request link to Slack, and the delivery record (planned vs actual) |

Run inputs: `source` (`jira` or `github`), `ticket`, `repo` (the repository to change, `owner/name`)
and optional `base_branch`.

## Cole Medin's skills in the agent steps

Each agent's method comes from [coleam00/skills](https://github.com/coleam00/skills) (MIT), adapted
for one-shot steps with read-only tools, with `LICENSE` and `SOURCE.md` next to each:

| Skill here | Adapted from | What changed |
|---|---|---|
| `requirements-brief` | `plan-create-prd`, questions of `piv-plan-implementation` | The interview became open questions with recommended defaults that a person answers at `design_review`; grounded in the checkout with cited evidence |
| `implementation-plan` | `piv-plan-implementation`, `plan-architecture` | Approaches with trade-offs, then files, patterns (`path:line`), tasks with `satisfies`, test plan and confidence, as structured output |
| `implement-change` | `piv-implement`, `piv-implement-issue`, `piv-validate`, `piv-commit`, `piv-create-pr` | Drift check, task-by-task edits, tests per criterion, never weaken a test; the worker runs the tests; commit message and pull request text are output, and the push is a gated gateway step |
| `fresh-eyes-review` | `piv-review-pr`, `piv-review-changes`, `prime-codebase` | The pull request review example's skill, reviewing a diff against the base checkout |

## Write-mode workspaces (engine)

An OpenCode agent node's `workspace` takes `mode: write` and an optional `test`:

```yaml
workspace:
  repo: {ref: inputs.repo}
  ref: HEAD
  credential: github-read-token    # read-only: the clone; nothing is pushed from the worker
  mode: write
  test: {command: "npm ci && npm test", timeout: 15m, attempts: 3}
```

- The checkout is the isolated one of the PR review example (fresh folder, token only in the
  fetch, host git config ignored, deleted after). In write mode its git directory is moved out of
  the folder, so the agent's edits cannot reach hooks, config or filters.
- OpenCode gets its edit and write tools (from the workflow, never from the profile) with edits
  allowed inside the checkout only. The shell stays off; external directories stay denied.
- After `submit_output` the worker stages the change, runs the test command in the checkout, then
  puts the checkout back to the staged change (so test byproducts never reach it). A failing run is
  sent to the agent with its output while attempts remain.
- The output gets `workspace`: `repo`, `ref`, `base_sha`, `files` (path, status, mode, content as
  UTF-8 or base64, line counts), `diff` (capped at 200,000 characters), `stats` and `tests` (status,
  command, exit code, attempts, output tail). The compiler type-checks refs into it, and an agent's
  `output_schema` may not declare `workspace`. Limits: 300 files, 1 MB of content; symbolic links
  and nested repositories are refused.
- **The test command runs repository code on the worker**, including code the agent wrote, so the
  run plan marks it unobservable. Its environment has no secrets (PATH, the step's own HOME and temp
  folder, `CI=true`, proxy settings). Run it on a worker you would trust as a CI runner for the
  repository.

## The write tools

- `github.push-branch` (write-dedupable) commits the `files` onto `base_sha` with the Git Data API
  (blobs, tree, commit, ref): no clone or git on the gateway. Branches must start with
  `branch_prefix` (default `azhi/`) and are made git-safe (`azhi/acme/shop#42` becomes
  `azhi/acme/shop-42`). A branch whose last commit Azhi did not make is refused; Azhi's own branch is
  moved (a re-run after a send-back). The commit message ends with an `Azhi-Action:` trailer, which
  the ledger uses to find a push whose response was lost. Paths must be plain repository paths
  (no `..`, no `.git`), only modes 100644 and 100755.
- `github.create-pull-request` (write-dedupable) opens a pull request from an `azhi/` branch, or
  returns the one already open for it; an empty `base` means the default branch.
- Both use the `github-write-token` secret and only the repositories given at install, and both run
  after `release_approval` behind CEL guards (`args.repo == inputs.repo`, the branch named for the
  ticket), so no tainted agent can reach them on its own.

## Setup

Try it on a throwaway repository first.

```bash
azhi example install sdlc-implement --repo OWNER/REPO --set slack_channel=C0123ABCD \
  --set test_command="npm ci && npm test"          # or Mission Control > Examples
azhi copilot login                                  # or Secrets > Sign in with GitHub Copilot
azhi secret set github-read-token                   # read-only Contents + Issues
azhi secret set github-write-token                  # Contents + Pull requests: read and write
azhi secret set jira-api-token                      # the run plan asks for it even for GitHub tickets
azhi run <version-id> --published -i source=github -i ticket=OWNER/REPO#1 -i repo=OWNER/REPO --wait
```

`test_command` defaults to `npm ci && npm test`. The example shares the tool ids `github.get-issue`,
`jira.get-issue` and `ticket.normalize` with `examples/sdlc`, so installing either sets the
repositories and Jira settings both use.

## Verified

`test/sdlc-implement.test.ts` runs OpenCode for real against a scripted model endpoint, a local git
host and a fake GitHub: the example installs with its settings, the run plan has no blockers, the
design review refuses an approval without answers, the build's first change fails the repository's
tests and the agent fixes it on the second attempt, the change holds exactly the agent's files (not
the test run's stray file), no token reaches the model or the test environment, and after the
release approval the branch holds one commit on the base with the fixed files and one pull request
is open; a run whose review does not approve pushes nothing. `test/github-write-tools.test.ts` and
`test/workspace-write.test.ts` cover the tools and the checkout on their own. Not yet run against a
live model or github.com.
