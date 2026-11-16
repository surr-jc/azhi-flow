# SDD breakdown (no tracker)

Takes the text of one epic, has an analyst agent size it against the repository and propose ordered slices, lets a
person approve the plan (and leave slices out), and returns the Stories as data. It writes nothing anywhere: no
GitHub issue, comment or label, no branch. The only thing it posts is one Slack message.

It is the no-tracker counterpart of [`issue-splitter`](../issue-splitter): the analysis (`scope-analyst@1`, the
`scope-analysis` and `definition-of-ready` skills), the size rules and the approval are the same. A parent workflow
(`sdd-factory` with the tracker set to "files") reads the Stories from this run's output and delivers them one by one.

## Flow

`ticket` (script) -> `analyze` (agent) -> `scope_gate` -> `weight` (rules: single or split) -> `plan_review` (approval,
author role, 72 hours, rejects on expiry; the decision field `drop` names slices to leave out) -> `final_plan` (script)
-> `stories` (script, the output) -> `notify_gate` -> `notice` -> `notify` (Slack).

If the analyst says the epic is not a code change, the run stops after `scope_gate`: Slack is told why and `stories`
returns `status: "not_code"`. A rejected plan ends the run successfully with no `stories` step at all.

## Inputs

| Input | Required | Meaning |
|---|---|---|
| `repo` | yes | `owner/name` the analyst reads (credential `github-read-token`) |
| `text` | yes | the epic, 1 to 20000 characters |
| `base_branch` | no | branch the analysis reads; empty means the default branch |
| `epic` | no | integer >= 1, the epic's number in the plan; echoed back |
| `release` | no | release id, `^[a-z0-9][a-z0-9-]{0,60}$` or empty; echoed back |

## Output contract

The step with id `stories` outputs:

```json
{"status": "ok", "epic": 3, "release": "v1", "stories": [{"slice": 1, "title": "...", "body": "..."}]}
```

- `status`: `ok` (at least one Story), `none` (the person left every slice out, or the input could not be read) or
  `not_code` (the analyst said it is not a code change). `epic` and `release` are echoed, or `null`.
- `stories` are in delivery order, dependencies first, at most 6, `slice` numbered 1..N after the approver's drops. A
  single (not split) epic is one Story: the epic itself.
- `title` is one plain line of at most 200 characters, with `<` and `>` replaced by spaces. `body` is Markdown of at most
  19000 characters: `Part of epic <n>: <title>` at the top when the epic number is given, then the goal, the scope, the
  acceptance criteria and the order (`Depends on slice N: <title>`; a dependency the person left out is named without a
  number). Control characters other than newline and tab are removed. Both are built by a script from the analysis
  fields, never by a second agent.
- A failure before `stories` fails the run. A rejected or expired plan skips `stories`: a parent should read a missing
  step as a split that did not happen.

## How it differs from issue-splitter

- No `issue` input and no ticket reading; the epic is text.
- No tools. Nothing creates issues, comments or labels, so there is no write to gate except Slack, and no `parent`,
  `outcome` or `mode` steps.
- The result is data (`stories`), not a set of created issues, and it carries the epic and release it was given.

## Install

```bash
npx azhi example needs sdd-breakdown
npx azhi example install sdd-breakdown --repo OWNER/REPO --set slack_channel=C0123ABCD
```

Secrets: `github-read-token` (read-only Contents), `github-copilot-token` (the analyst runs on a Copilot model through
OpenCode) and `slack-bot-token`.
