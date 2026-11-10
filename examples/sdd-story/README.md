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

- `base_branch` is the branch the pull request targets. `stack_on` is the branch the work is cut from (the
  previous Story's `azhi/` branch); empty means `base_branch`. `mode` is accepted (`supervised`, `auto`) but only
  `supervised` is built: a person approves the specs and signs off.
- Tests: `.azhi/commands.json` in the repository wins, otherwise the stack is detected (see
  `scripts/gate.js`). A repository whose test command cannot be found has not passed, and the Story is sent back.
- Review: `review_outcome.py` reads the child's verdict. A child that failed, or a verdict it cannot read, is
  `unavailable` and the Story is sent back. Findings the review triaged as fix-now go to the `fix` agent as data;
  its tests must pass before the same branch is pushed again. The fix is not reviewed again, and the sign-off
  says so.
- Result: `result` ends every route with `{status: signed_off | sent_back, reason, branch, head_sha, pr_number,
  pr_url}` for a parent workflow to read. The signed-off ticket gets the `signed_off_label` label.

If the gate command in `workflow.yaml` needs rebuilding after a change to `scripts/gate.js`:
`node examples/sdd-story/scripts/build_gate_commands.mjs --write`.
