# PR conflict resolver: from a conflicting pull request to a checked resolution

Give it a pull request that GitHub reports as conflicting. It merges the base branch into a checkout of the
pull request, settles the easy hunks with plain rules, has an agent resolve the rest, runs your tests on the base,
on the pull request and on the result, and has an independent reviewer and a refuter challenge it. After a person
approves, it pushes the result to a new `azhi/resolve-<number>-<sha>` branch and opens a pull request from it into
the **pull request's own branch**. Nothing is pushed to the contributor's branch, merged or force-pushed.

## Before you start

| Needed | How |
|---|---|
| A running server whose worker has **OpenCode, git and Python** | `node bin/azhi.js up` from this repository. The worker must be a build with `workspace_merge` (the plan shows it). |
| **GitHub access** | Either the GitHub CLI (`gh auth login`, then `azhi github login`), or the secrets `github-read-token` (Contents and Pull requests: read) and `github-write-token` (Contents and Pull requests: write; used only after approval). |
| A **GitHub Copilot** sign-in for the models | `azhi copilot login` (secret `github-copilot-token`). |
| The repository named on the tools | Install from the marketplace and name it, or edit `repos` in `azhi.config.yaml`. |
| Your **test command** | In `workflow.yaml`, `test:` of the `base_run` step (default `npm ci && npm test`); the other steps repeat it by reference. |

## Run it

```bash
azhi run examples/pr-conflict-resolver -i repo=OWNER/REPO -i pr=123
```

## What happens

1. **Eligibility.** Open, from this repository (not a fork), `mergeable_state` dirty. Otherwise it stops, spending nothing.
2. **Merge.** The worker merges the live base branch into the pull request's head. Conflicts stay as diff3 markers.
3. **Rules.** Identical, one-sided, whitespace-only and import or changelog additions are settled without a model.
   A delete-against-edit conflict, a binary file or a lock file is set aside for a person.
4. **Resolve.** An agent resolves the remaining hunks, editing only the conflicting files. The tests run on the result.
5. **Check.** A script compares the tests on the base, the pull request and the result, and checks the files: no
   markers left, nothing changed outside the conflicts, no change of the pull request dropped.
6. **Review.** An independent reviewer reads the result against what each side meant; a refuter on another model
   tries to disprove each critical or major finding.
7. **One more try.** If rejected, one stronger second attempt starts from the first and is told why.
8. **Approval, then push.** You see the diff, the checks and the findings. On approval it pushes the branch, opens
   the pull request (a **draft** if anything is in doubt) and comments on the original.

If a conflict is set aside, or both attempts fail, it comments why on the original pull request and pushes nothing.

## How much was verified

| Result | Meaning |
|---|---|
| `pass` | The tests passed on the result. |
| `inconclusive` | The tests did not run, or a parent also fails so the result cannot be blamed. Opens as a draft. |
| `regression` / `invalid` | The tests fail where both parents pass, or a marker, an unrelated edit or a dropped change was found. Blocks. |

## Known limits

- Merge the resolution pull request into the contributor's branch with a **merge commit**.
- The commit on the `azhi/` branch has one parent (the base tip): GitHub reports the content as clean, but the
  history does not show a merge. A two-parent merge commit is a follow-up.
- Lock files, deleted-against-edited files and binary files are left to a person: the resolver has no shell.
- Forks are skipped. The tests run the pull request's code (`npm ci` runs install scripts) on the worker.
- The merge needs the full history of both branches, so it is slow on very large repositories.
- Per-test comparison needs the test command to print `AZHI_RESULT {"failed_ids": [...]}`; without it the
  comparison uses pass or fail of each run.
