# SDD Factory

A goal or a ticket to a stack of signed-off pull requests, spec first. It plans a release with a person, splits it into
Stories, asks once before delivering, then delivers the Stories in order: each one is its own run of `sdd-story`, cut
from the branch of the Story before it. It ends with a check of the whole release and a summary that says which pull
requests to merge, in which order. Nothing merges.

```bash
npx azhi example needs sdd-factory
npx azhi example install sdd-factory --repo OWNER/REPO --set slack_channel=C0123ABCD
npx azhi run examples/sdd-factory -i source=github -i repo=OWNER/REPO -i base_branch=dev -i goal="Let customers pay by card"
```

Install, sign and publish the children first: `issue-splitter`, `sdd-story`, `pr-review` and `ai-sdlc-factory-verify`,
and `sdd-breakdown` if you run with `source=files`. A child is resolved when its step starts, so a missing one stops the
run there.

With `source=files` there is no tracker: the Stories are not issues and nothing is created on GitHub. `goal` is
required and `ticket` must be empty.

```bash
npx azhi run examples/sdd-factory -i source=files -i repo=OWNER/REPO -i base_branch=dev -i goal="Let customers pay by card"
```

```
brief ─ brainstorm ─ person ─ plan ─ person ─ epics ─ release ─ tracker_gate ─ github: split_epics (loop, one issue-splitter per epic)
                                                                 └─ files:  breakdown_epics (loop, one sdd-breakdown per epic)
        summary ◄─ release_check ◄─ deliver_stories (loop, one sdd-story per Story) ◄─ autonomy (person) ◄─ order ─ breakdown_doc
```

- With `source=files` the Stories are named `<release>-s1`, `-s2` and so on (the release id is a slug of the plan's title
  and six random hex characters, so two runs never share branches; a resumed run keeps its names). The branches are
  `azhi/<release>-sN`.
- The breakdown of the release (the plan and every Story) is committed as `docs/release/<release>/breakdown.md` in the
  first Story's pull request, so a person reviews the plan there. The other Stories do not carry it.

- `base_branch` is where every pull request goes. The first Story is cut from it; Story N from the branch Story N-1
  left, so each pull request builds on the one before it. Merge them in the order the summary lists.
- The release is at most 3 epics and 20 Stories. More than 20 stops the run before anything is delivered.
- A Story that is not signed off stops the loop: nothing is stacked on a branch that was not signed off.
- The autonomy question offers `supervised` (a person approves each Story's specs and signs each one off; the default)
  and `auto` (no person is asked where the rules say it is safe, recommendations are taken, every decision is posted
  to Slack, anything doubtful still asks). The plan and the tickets are always approved by a person.
- Every question comes with a recommendation: the brainstorm questions here, and the spec author's open questions in
  `sdd-story`. A person can leave an answer empty to take it.
- The loops' exit rules read only their own round's steps (`split_outcome.last`, `breakdown_outcome.last`, `story_outcome.last`), not a step
  outside the loop. A gate that read an outside step would run for rounds that never started and fail the run.
- Tests: `test/sdd-factory.test.ts` (compile, gates, every script) and `test/sdd-factory-e2e.test.ts` (the engine, with
  scripted agents and stand-in children).
