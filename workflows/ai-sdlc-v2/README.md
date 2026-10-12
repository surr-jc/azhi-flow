# AI-SDLC v2: governed delivery from a GitHub issue to a draft pull request

Give it a GitHub issue. It checks the ticket is ready, plans the change, builds it, has an independent
reviewer and a verifier challenge it, and, after a person approves, pushes a branch and opens a pull
request. Nothing reaches GitHub without that approval, and the pull request says plainly how much was
verified.

## Before you start

The preflight checks most of this and says what to fix, but it is quicker to have it ready.

| Needed | How |
|---|---|
| A running server whose worker has **OpenCode, git and Python** | `node bin/azhi.js up` from this repository. If `AZHI_OPENCODE_BIN` is set (a user environment variable), it must point at an OpenCode that exists; after moving the repository, update it. |
| **GitHub access** that can read and write the repository | Either the **GitHub CLI**: run `gh auth login` on the server's machine (scope `repo`), then `azhi github login` (or the "GitHub CLI login" panel on the Secrets page). Or tokens: set the secrets `github-read-token` and `github-write-token`; a fine-grained token needs **Contents** and **Pull requests**: Read and write. The preflight proves write access with a harmless test write and names the missing permission. |
| A **ChatGPT plan** sign-in for the models | `azhi chatgpt login` (secret `openai-chatgpt-auth`). |
| **Slack** for notices (optional) | Secret `slack-bot-token` and the channel in `config.channel`. |
| The GitHub tools allowed to use the repository | `repos` of `github.get-issue`, `github.push-branch` and `github.create-pull-request` must list it. |

## Run it

```bash
azhi run workflows/ai-sdlc-v2 -i source=github -i ticket=OWNER/REPO#28 -i repo=OWNER/REPO -i base_branch=dev
```

`base_branch` is required. Name the branch the ticket was written against: the repository's default
branch can be far behind it, and the plan would then look for code that is not there.

You are asked twice: to approve the **design** (answering its open questions, as selections) and to approve
the **release** (the change, the findings and an acceptance-criteria checklist are shown). `azhi run` does a
preflight first; `--no-preflight` skips it.

## What happens

1. **Intake and readiness.** Reads the issue; a cheap model checks it is specific enough to build.
2. **Preflight on the base branch.** Runs the test command on the untouched branch, so a repository whose
   tests cannot run is found before any expensive step.
3. **Plan.** One pass writes the requirements and the design, searching the migrations and the code for what
   already exists. You approve it.
4. **Build, review, one fix round.** The engineer builds; one independent reviewer checks the diff and each
   acceptance criterion; a verifier tries to refute each critical or major finding; one fix round follows if
   findings stand. A fix is reviewed again only if it changed the diff.
5. **Release approval.** You see the diff, the findings and the criteria checklist. On approval it pushes
   `azhi/<ticket>` and opens the pull request.

## How much was verified

The pull request title and first lines say which of three levels applies:

| Level | Meaning |
|---|---|
| (no tag) | The whole test command passed on the base and after the change. |
| `[static-checks-only]` | The full tests cannot run here. Typecheck and build passed, and **the test files the agent added or changed were also run**. A new test that fails blocks the change; a failing edit to an existing test is reported, not blocking (it may fail on the base too). |
| `[untested]` | Nothing could run and a person chose to continue. |

Anything but the first is always a **draft**, as is a change with a migration or a sensitive area, or one
whose reviewers still have critical or major findings, or whose acceptance criteria are not all met.

A draft's `Closes #N` is rewritten to `Refs #N`, so merging it cannot close a ticket it does not finish.

## Known limits

- One fix round. Several findings of the same kind can survive it; the pull request lists them.
- The tests the full suite would run are not run in static mode, only the ones the agent touched.
- Policy and rules added by the change are checked by reading and by those tests, not by a person's trial.
- The test command is a string of at most 1000 characters; `scripts/verify_static.js` is the readable
  source of the static one and `scripts/build_verify_command.mjs` prints the compressed command to paste.

## Changes since the first version

See `CHANGELOG.md`.
