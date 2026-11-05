# OpenSpec flow

`examples/openspec-flow` runs the [OpenSpec](https://github.com/Fission-AI/OpenSpec) lifecycle as a governed
workflow: the requirements of a change are files in the repository that a person approves before code is
written, the code is checked against them, and the finished change is merged into the specs by a step whose
result is checked by a script.

Install: `azhi example install openspec-flow --repo OWNER/REPO --set slack_channel=...`.
Run: `azhi run examples/openspec-flow -i source=github -i ticket=OWNER/REPO#42 -i repo=OWNER/REPO -i base_branch=dev`.

## What it borrows from OpenSpec

| OpenSpec | Here |
|---|---|
| `openspec/specs/<capability>/spec.md`, the source of truth | Read by `scan`; changed only by `archive` |
| `openspec/changes/<id>/` with `proposal.md`, delta specs, `tasks.md`, optional `design.md` | Written by `propose`; the id comes from `pick_change_id.py` |
| `ADDED`, `MODIFIED`, `REMOVED`, `RENAMED` requirements; SHALL/MUST; `#### Scenario:` with WHEN/THEN | Rules in the `openspec-format` and `delta-specs` skills; enforced by `spec_check.py` |
| `openspec validate --strict` | `check_1` / `check_2` (`spec_check.py`, mode `change`) |
| propose, then implement only after approval | `proposal_approval`, a real approval node (OpenSpec has it only as a convention) |
| `verify` (completeness, correctness, coherence; advisory) | `verify`, read-only, shown at `release_approval` |
| `archive`: merge deltas, move to `changes/archive/<date>-<id>/` | `archive` plus `archive_check` |
| `project.md`, `config.yaml` | If the repository has no `openspec/`, `propose` creates `openspec/config.yaml` and `specs/.gitkeep` |

## Steps

```text
intake -> change_id, scan -> propose -> check_1 -+-> pass_1 ------------------+
                                                 +-> revise -> check_2 -+-> pass_2 -> spec_change
                                                                         +-> check_fail_notify (stop)
spec_change -> spec_review -> proposal_approval -> apply -> verify -> release_gate
release_gate -> release_approval -> archive -> archive_check -> push_branch -> open_pr -> release -> summary
                 (tests failed: tests_notify)        (check failed: archive_fail_notify)
```

- **Check and one fix round.** A script validates the change; if it fails, the author gets the exact errors
  once. A second failure stops the run with the errors in Slack, and nothing is built.
- **Two approvals.** `proposal_approval` (admin) sees the delta list, the reviewer's findings, open questions
  and the spec diff; its notes reach the engineer. `release_approval` (admin) sees the diff, the test result and
  the verification report.
- **Nothing merges, closes or force-pushes.** The branch is `azhi/<ticket key>` and the pull request is
  opened as a draft when the tests did not pass or the verifier found a CRITICAL issue.

## How the archive is checked

A `script` step receives only JSON, so it cannot read the checkout. The merge is therefore done by the
`archive` agent (a mechanical procedure in the `spec-archive` skill) and **proved by postconditions** in
`spec_check.py` mode `archive`, using the files the step returns:

- every ADDED and MODIFIED requirement appears in the merged spec, character for character; REMOVED ones are
  gone; RENAMED ones moved; names are unique; every requirement still has SHALL/MUST and scenarios;
- the change folder is gone and every file is under `changes/archive/<date>-<id>/` with identical content;
- no code file, other spec or other change differs from what `apply` left.

A failed check stops before `push_branch`. Limits worth knowing: the check cannot prove that a requirement
the delta does not mention was left untouched (it can only prove no unrelated spec changed), and
`MODIFIED/REMOVED/RENAMED` targets are validated against the requirement names the `scan` agent read.

## Files

`workflow.yaml`, `azhi.config.yaml` (GitHub tools, Slack channel setting), `profiles/` (scanner, author,
reviewer, engineer, verifier, archiver), `harness/` (agent and command prompts, six skills), `schemas/`,
`scripts/` (`pick_change_id.py`, `pick_change.py`, `spec_check.py`), `templates/`.
Tests: `test/openspec-flow.test.ts` (compiles, taint gates) and `test/openspec-flow-scripts.test.ts`
(the script rules, including each archive failure).

## Not verified by a live run

The definition compiles and the scripts are tested, but the workflow has not been run against a real
repository. Check on the first run: that `workspace.from` continuation carries the proposal files into
`apply` and `archive` (the cumulative `workspace.files` feed `archive_check` and `push_branch`), and that the
default test command suits the target repository (edit the `apply` node's `workspace.test.command`).
