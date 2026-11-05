# PR conflict resolver

`examples/pr-conflict-resolver` resolves the merge conflicts of a pull request and checks the result before a
person approves it. Its README says how to run it. This page says what it relies on and why.

## Why it is built this way

A one-shot "ask a model to fix the markers" resolver cannot tell a wrong merge from a right one. The better
designs seen in other projects (MergeAgent, agent-resolve-merge-conflicts, LLMinus) do four things, and so does this
workflow: settle what rules can settle first, keep the model away from write credentials, compare tests before and
after, and make a second party challenge the result.

| Idea | Here |
|---|---|
| Rules before the model | `scripts/triage.py` settles identical, one-sided, whitespace-only and import or changelog hunks. |
| The model holds no write token | Every agent step reads with `github-read-token`; only the tool steps after the approval write. |
| Differential testing | `base_run`, `head_run` and the resolver's own test run use one command; `scripts/compare.py` judges them. |
| Independent challenge | A reviewer, and a refuter on another model; a confirmed critical or major finding blocks. |
| Unknown is not a pass | A run that cannot be compared is `inconclusive` and opens as a draft. |

## What the platform provides

- **`workspace.merge_ref`.** A write-mode or read-only agent workspace can merge a second ref into the checked-out
  one (`git merge --no-commit`) on the worker, with git hooks off and no host git config. Conflicts stay in the tree
  as diff3 markers. The step's `workspace` output gains `merge: {base_sha, head_sha, conflicts}`, each conflict with
  a kind (`both_modified`, `both_added`, `deleted_by_us`, `deleted_by_them`, `added_by_us`, `added_by_them`). The
  change is measured from the merged tip, so it is the pull request's own change plus the resolutions even when the
  base has moved far. It needs the full history and cannot be combined with `depth`, `base_ref` or `from`; a worker
  must advertise `workspace_merge`.
- **`github.get-pull-request`** also returns `head_repo`, `head_is_fork` and `maintainer_can_modify`.
- **The GitHub tools' `cli_fallback`**, described in `docs/github-data.md`, keeps the workflow working behind a
  certificate-inspecting proxy or with a token GitHub rejects.

## Limits that follow from the design

- The resolution is pushed with `github.push-branch`, a single-parent commit on the base tip, because that tool
  writes only `azhi/` branches. A two-parent `github.push-merge` is the next step.
- Agents here have no shell: they cannot regenerate a lock file or delete a file, so those conflicts are set aside.
- `give_up` comments on the pull request without an approval, like the PR review's comment; it only reports.
