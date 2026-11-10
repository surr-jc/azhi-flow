# SDD Story

One Story (a ticket) to a signed-off pull request, spec first. It is `openspec-flow` with a different ending:
a GitHub issue becomes an `openspec/changes/<id>/` folder a person approves, the tasks are built with tests
(the repository's own test command, found the way `sdlc-universal` finds it), the change is verified against
its specs and archived (checked by a script), and one `azhi/` branch is pushed and a pull request opened. Then
`pr-review` reviews that pull request as a child run, the confirmed findings get one fix round, and a person
signs it off. Nothing merges.

```bash
npx azhi example needs sdd-story
npx azhi example install sdd-story --repo OWNER/REPO --set slack_channel=C0123ABCD
npx azhi run examples/sdd-story -i source=github -i ticket=OWNER/REPO#42 -i repo=OWNER/REPO -i base_branch=dev
```

Install `pr-review` too: the `review` step runs it.

## Source: github or files

- `source: github` (default behaviour): `ticket` is a GitHub issue (`OWNER/REPO#N`). It is read, and labelled
  `signed_off_label` once signed off.
- `source: files`: a release run without a tracker. A parent workflow gives the Story as inputs and nothing is read
  from or written to any tracker (no issue read, no label):
  - `story_key` (required, `^[a-z0-9][a-z0-9-]{0,60}$`): the ticket key and the branch `azhi/<story_key>`, so the
    next Story can use it as `stack_on`.
  - `story_title` (required, up to 200 characters) and `story_body` (required, Markdown, up to 19000).
  - `ticket` must be empty or absent. The GitHub-only inputs may be passed empty, and the files-only inputs
    (`story_key`, `story_title`, `story_body`, `extra_files`) may be passed empty with `github`.
  - `files_ticket.py` turns them into the same ticket `ticket.normalize` returns (the title becomes one line
    without control characters or angle brackets, the body loses control characters other than newline and tab and
    is cut to 20000). An invalid key, or an empty title or body, fails the run: the Story is not signed off.
  - `intake` joins whichever ticket was read, so every step reads `nodes.intake.output` as before. The pull request
    body and the Slack lines print the ticket url only when there is one.
- `extra_files` (optional, up to 3 `{path, content}`): Markdown files the pull request adds besides the change, for
  example the release breakdown, so the plan is reviewed in the first Story's pull request. `path` must match
  `docs/release/<release>/<name>.md` and `content` is at most 60000 characters. `push_files.py` builds the push:
  each valid extra is an added file, an agent file at the same path is dropped (the extra wins), and an extra that is
  not valid (a `..` in the path, a repeated path, content that is not text) is left out and its path is listed in
  the sign-off payload as `extra_files_ignored`: a documentation file never fails the Story. More than 3 extras, or
  more than 300 files in the push with them, push none of them and list all of them. The fix round's re-push
  replaces the branch's single commit, so `push_fix_files` adds the extras again. Works with either source.

- `base_branch` is the branch the pull request targets. `stack_on` is the branch the work is cut from (the
  previous Story's `azhi/` branch); empty means `base_branch`. `mode` is `supervised` (default) or `auto`; see
  below.
- Tests: `.azhi/commands.json` in the repository wins, otherwise the stack is detected (see
  `scripts/gate.js`). A repository whose test command cannot be found has not passed, and the Story is sent back.
- Review: `review_outcome.py` reads the child's verdict. A child that failed, or a verdict it cannot read, is
  `unavailable` and the Story is sent back. Findings the review triaged as fix-now go to the `fix` agent as data;
  its tests must pass before the same branch is pushed again. The fix is not reviewed again, and the sign-off
  says so.
- Open questions: the spec author lists each as `{question, recommendation, why}`. The recommendation is the
  answer to take if nobody answers, specific enough for the engineer to act on; `why` says what it changes. A
  question it cannot recommend an answer for is not an open question.
- Mode: `supervised` asks a person at the two approvals, the specs (`proposal_approval`) and the sign-off
  (`signoff`). In `auto` two scripts decide whether to ask, and the approval is reached only when they say `ask`.
  Only the exact word `auto` is auto: `Auto`, an empty or a missing mode is supervised. Anything a script cannot
  read asks.
  - Specs (`specs_gate`) go on without a person only when the spec review approved with no blocking finding and
    saw no prompt injection, the check passed, there are no conflicts, and there are at most 10 open questions,
    each with a recommendation. Otherwise it asks, with the reason in the approval message (`supervised`,
    `review_not_approved`, `prompt_injection`, `check_failed`, `conflicts`, `no_recommendation`, `unreadable`).
  - The sign-off (`signoff_gate`) goes on without a person only when the build tests passed, the review approved
    itself (a fix round after a review that asked for changes does not count: nobody reviewed the fix, so a person
    signs it off), the verifier found no CRITICAL issue and saw no prompt injection,
    the spec reviewer saw none, the pull request is not a draft, and no remaining finding is `check_by_hand`.
    Otherwise it asks (`tests_not_passed`, `review_not_clean`, `fix_not_reviewed`, `critical_issue`, `prompt_injection`,
    `draft_pull_request`, `needs_hand_check`, `unreadable`).
  - Every decision taken without a person is posted to Slack (`specs_notify`, `signoff_notify`): the ticket, the
    grounds, each question with the recommendation taken and its why, the pull request, tests, review and fix
    round (and that the fix was not reviewed again). The engineer gets the recommended answers as notes. Text
    from the ticket, repository or author is cleaned (control characters and angle brackets removed, items cut to
    300 characters, a text to 3000) before it is posted.
  - `specs_decision` and `signoff_decision` join the person and the rules; the steps after read only those. A
    person who leaves the specs notes empty gets the recommended answers too, in supervised mode as well.
- Result: `result` ends every route with `{status: signed_off | sent_back, reason, branch, head_sha, pr_number,
  pr_url}` for a parent workflow to read. With `github`, the signed-off ticket gets the `signed_off_label` label (`label_choice`); with `files` there is
  nothing to label. `story_notify` waits for the sign-off, not for the label.

If the gate command in `workflow.yaml` needs rebuilding after a change to `scripts/gate.js`:
`node examples/sdd-story/scripts/build_gate_commands.mjs --write`.
