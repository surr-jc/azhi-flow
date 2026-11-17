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
  must advertise `workspace_merge`. A workspace's fetch is tried up to three times (waiting 2 s, then 5 s) within the
  step's fetch timeout, so one dropped connection does not fail the run; a missing ref, a refused token and a
  cancellation are not retried. The step itself is never retried, because that would run its agent again.
- **`github.get-pull-request`** also returns `head_repo`, `head_is_fork` and `maintainer_can_modify`.
- **The GitHub tools' `cli_fallback`**, described in `docs/github-data.md`, keeps the workflow working behind a
  certificate-inspecting proxy or with a token GitHub rejects.

## Order of the heavy steps

`merge_attempt`, `base_run` and `head_run` run one after another, in that order, and `triage` waits for all three.
Run side by side, the two test suites loaded the machine enough that the full-history fetch of `merge_attempt`
dropped its connection; the test snapshots also should not compete for the machine. On the skip route all three
are skipped with `merge_attempt`.

## Attempts

The resolver, the comparison, the reviewer and the refuter are the body of one loop, `attempt` (see
`docs/loops-and-subworkflows.md`), at most two rounds. A rejected first attempt gets a second on a stronger model,
which starts from the first attempt's files and is told why it was rejected. Everything after the loop reads
`nodes.attempt.output`, so what `finalize` ships and what the approver sees is always the last attempt. When `triage`
sets a conflict aside the loop is skipped, and `finalize` runs with no attempts to say why.

## Cross-file breaks (integration fixes)

Git merges two changes cleanly that are inconsistent together: one side re-types a method, the other adds a caller
of the old one. No conflict marker shows it, and the build breaks. The resolver therefore does an integration pass
after the hunks (skill `merge-conflict-resolution`): it lists what each side changed, searches the repository for
the use sites, and applies the smallest fix that keeps both sides working (an overload or adapter over rewriting the
other side's callers, the pull request's change on top of the base's new code). Each file it edits outside the
conflicts is declared in `integration_fixes` with a reason. `compare.py` accepts declared edits, lists them as
`integration_edits`, and still marks an undeclared edit, or a declared one under `.github`, `.claude`, `.hooks`,
`.husky` or a lock file, `invalid`. A result with integration edits is never "clean": it opens as a draft, the
approval message and the pull request name the files, and the reviewer checks each one is minimal and necessary.

Whether the code still builds is judged by the `test_command` setting, which is any shell command, not only npm
(`mvn -q -o -DskipTests compile` is a compile check for Java). A failing build on the result where the base and the
pull request pass is a `regression`, and the second attempt is told which one.

## The prompt-injection flag

The resolver and the reviewer set `prompt_injection_detected` only for text that addresses an AI agent or tool, or
tries to change its task (its instructions, output or verdict, what it reads or runs, what it reveals). Notes to
human readers, commands and evidence records in a description, code, comments, docs, fixtures and a project's own
agent prompts do not count, unless they try to change the task. When unsure, the agent sets it.

The flag stays a hard stop: the `attempt` loop's first exit rule and `finalize.py` stop on any `true`, with or
without evidence.
Each agent also quotes the text and where it found it in `prompt_injection_evidence` (up to five items). That text is
untrusted, so it is not forwarded to another agent and not put in the pull request comment; read it in the step's
stored output with `azhi inspect`.

## Limits that follow from the design

- The resolution is pushed with `github.push-branch` and its `merge_parent` argument, because that tool writes only
  `azhi/` branches. The commit is a real merge: parents are the base tip and the pull request's head (the commit
  the merge attempt was made from, `triage.pr.head_sha`), and its tree is the resolved tree. The resolution pull
  request therefore merges into the contributor's branch without raising the conflicts again. Merge it with a
  merge commit: a squash or rebase drops the base-tip parent, and the contributor's branch is then as far behind the
  base as before.
- Agents here have no shell: they cannot regenerate a lock file, delete a file or compile. They learn that a fix did
  not build from the check after the attempt, and the second attempt starts from it.
- `give_up` comments on the pull request without an approval, like the PR review's comment; it only reports.
