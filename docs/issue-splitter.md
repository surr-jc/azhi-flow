# Issue splitter (GitHub and Jira)

`examples/issue-splitter` and `examples/issue-splitter-jira` size a ticket against the code and, when it is
too big for one pull request, split it into ordered, linked sub-issues. They exist to fix the scope of a
ticket **before** the delivery workflow ([ai-sdlc](ai-sdlc.md)) builds it: that workflow stops a ticket that
fails its one-pull-request gate, and these turn it into tickets that pass.

The two are twins: the same analysis, rules, approval and layout. Only the reading and writing differ
(the GitHub API, or the Jira MCP server `mcp-atlassian`).

```
source ─ issue ── read the issue ──┐
        └ text ─ text_pass ────────┴ ticket ─ analyze ─ scope_gate ─┬ plan ─ weight ─ plan_review ─ final_plan ─ mode ─┬ single_existing ─ comment + label
                                                                    │          (rules)  (a person)                     ├ single_new ───── create one issue
                                                                    └ stop ─ stop_message ─ stop_notify                ├ split_existing ─ parent ─ issue_1 … issue_6 ─┐
                                                                      (not code: nothing is created)                   └ split_new ─ create umbrella ─ parent ─ …    ┴ outcome ─ comment on parent ─ Slack
```

## What a run does

1. **Read:** an existing issue (`issue`), or a request typed as free text (`text`; the Jira twin also needs the
   `project` to create issues in). An issue wins when both are given. The analysis reads the code of a GitHub
   repository (`repo`), so a Jira run names one too.
2. **Analyze:** an agent (skills `scope-analysis` and `definition-of-ready`) reports facts, not decisions:
   whether it is code, the independent deliverables, the estimated files, sensitive areas, risk, the ticket as one
   well-formed issue, and (when the work is wide) 2 to 6 ordered slices. Each slice has its criteria, its surface
   (`path:line`), what it depends on and a lite or full review rating.
3. **Stop on non-code:** an investigation, a decision or a manual task stops here: Slack is told why, nothing is
   created.
4. **Decide by rules** (`weight`), not by the agent alone. It is a **split** when the analyst proposed 2 or more
   slices **and** any of: more than one deliverable, more than `split_max_files` files (5), or a sensitive area in
   more than `split_sensitive_max_files` files (2). Otherwise it is **single**. Both numbers are in the workflow's
   `config:`. If the rules say split but no slices were found, it is treated as single and the approval says so.
5. **Approve** (`plan_review`, role `author`, expires in 72 hours as a rejection): a person sees the analysis and
   the plan and approves it, can name slices to **leave out** (`drop`, for example `2,4`), or rejects. **Nothing is
   written before this.**
6. **Write**, after the approval only:

| Case | What is created |
|---|---|
| Split of an existing issue | one sub-issue (GitHub) or sub-task (Jira) per slice, linked under it, and a comment on the parent listing them |
| Split of free text | an umbrella issue tracking the work, then the sub-issues under it |
| Single, existing issue | a scope comment and the `ready` label (Jira: the issue's labels plus `ready`) |
| Single, free text | one issue |

   Every slice's body says its acceptance criteria, its surface, its place in the order and what it depends on
   ("Do not start it before those are merged"). Nothing in Azhi merges anything, so slices are meant to be independent;
   a dependent one has to wait for a person to merge what it depends on. Slices are created in order, up to 6.
7. **Tell Slack** what was created, or why nothing was.

Then each created issue is an ordinary ticket: start the delivery workflow on it (inputs `source=github`, `ticket=owner/name#101`, `repo=owner/name`; for Jira, `source=jira` and the key). The `ready` label marks the slices that can be started now: those with no dependencies. A slice that waits for others is created without it, so a person (or a later queue) starts it only after what it depends on is merged.
Starting those runs automatically is not built. Each slice's pull request says `Closes owner/name#N`, so GitHub closes the sub-issue when a person merges it (and moves the parent's progress); nothing in Azhi closes an issue.

## Answering the approval

Mission Control > Approvals, or `azhi approve <run> plan_review --data '{"drop": "2"}'` (`--reject` to stop). From
Slack, **Approve** creates all of the plan in one tap (it has no required answer, so no form opens); to leave slices
out, use the web or the CLI. See [ai-sdlc.md](ai-sdlc.md#answering-from-slack) to set Slack approvals up.

## GitHub

```bash
azhi example install issue-splitter --repo OWNER/REPO --set slack_channel=C0123ABCD
azhi copilot login                           # or Secrets > Sign in with GitHub Copilot
azhi secret set github-read-token            # read-only Contents + Issues
azhi secret set github-write-token           # Issues: read and write (creates issues, labels, comments)
azhi run <version-id> --published -i repo=OWNER/REPO -i issue=27 --wait
azhi run <version-id> --published -i repo=OWNER/REPO -i text="Add on/off switches for providers and models" --wait
```

New tools: `github.create-issue` (write-dedupable) and `github.label-issue` (write-idempotent); the comment reuses
the PR-comment tool, which also works on issues. A created issue carries a hidden marker with its ledger action,
so a retry after a lost response finds it instead of creating a second one.

**Sub-issue links** use GitHub's sub-issues API (github.com; recent GitHub Enterprise Server). Where it is missing
the issue is still created, says "Part of #N" in its body, and the result reports it as **not linked**.

## Jira

```bash
azhi example install issue-splitter-jira --set slack_channel=C0123ABCD \
  --set jira_url=https://your-company.atlassian.net --set jira_username=you@example.com
azhi secret set jira-api-token               # reads the issue
azhi secret set jira-write-token             # creates issues, comments, edits labels (may be the same token)
azhi secret set github-read-token            # the code the analysis reads
azhi run <version-id> --published -i repo=OWNER/REPO -i issue=PAY-142 --wait
azhi run <version-id> --published -i repo=OWNER/REPO -i project=PAY -i text="..." --wait
```

The read goes through a read-only MCP server (`READ_ONLY_MODE=true`, only `jira_get_issue` enabled); each write tool
is its own registration with write mode and only that tool enabled, using the write token. Sub-tasks are created
with `jira_create_issue` (`issue_type` from `child_type`, default `Subtask`; the parent goes in `additional_fields`).
A sub-task cannot go under an Epic: put the sub-tasks under a Task or Story, or set `child_type` to a type your
project allows with a parent. `umbrella_type` and `new_issue_type` default to `Task`.

**No duplicates:** the Jira writes are write-dedupable but the MCP server has no lookup, so a write whose outcome
is unknown (the process died after the request was sent) is **not repeated**: the run stops and an operator checks
Jira, then decides. That means a rare stop, never a double issue.

## Verified

Against a stand-in GitHub and a stand-in Jira MCP server, with OpenCode running for real on a scripted model:
`test/github-issue-tools.test.ts`, `test/issue-splitter.test.ts` and `test/issue-splitter-e2e.test.ts` (split with
links and a comment, slices left out, single issue, text split with an umbrella, text single, not code, rejection,
an issue from another repository), and `test/issue-splitter-jira.test.ts` with `test/issue-splitter-jira-e2e.test.ts`
(sub-tasks with valid JSON fields, read and write tokens kept apart, umbrella, labels merged, rejection). Not yet run
against github.com or a real Jira, or with a live model; try a throwaway repository and project first.
