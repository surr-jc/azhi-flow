# Runbook: live smoke of the AI SDLC Factory

The unit and chain tests (`test/ai-sdlc-factory*.test.ts`) check the rules and that each stage's output is what the next
reads. They do not run the engine, a model or GitHub. This is the manual check for that, on a **throwaway repository**:
an approved run creates real issues, branches and pull requests. Nothing here merges or closes anything.

Needs: Temporal and the Azhi server running (`npm run azhi -- --help`, [windows-local-setup](../windows-local-setup.md)),
a throwaway GitHub repository with a README, a CI workflow and a `dev` branch, the secrets listed in each example's
`azhi.config.yaml`, and a Slack channel for the bot.

## 1. Install and publish

```bash
for e in sdlc-universal issue-splitter ai-sdlc-factory-plan ai-sdlc-factory ai-sdlc-factory-readiness ai-sdlc-factory-verify; do
  azhi example install $e --repo OWNER/REPO --set slack_channel=C0123ABCD
done
```

Sign and publish each draft, the delivery (`sdlc-universal`) and `issue-splitter` first: the plan and the lap run them
as child runs.

## 2. Walk the chain

| Step | Command | You should see |
|---|---|---|
| Readiness | `azhi run examples/ai-sdlc-factory-readiness --input source=github --input repo=OWNER/REPO --input base_branch=dev` | a scorecard in Slack; `unavailable` for anything unreadable, never a pass |
| Brainstorm + plan | `azhi run examples/ai-sdlc-factory-plan --input source=github --input repo=OWNER/REPO --input base_branch=dev --input goal="..."` | an approval with questions and 2-3 approaches (`brainstorm_review`); rejecting ends the run with nothing planned. After answering: the release plan approval (`prd_review`) |
| Split | (the plan continues) | per epic, the splitter's own approval, then issues labelled `ready` and `azhi-split` with "Slice N of M" |
| A lap | `azhi run examples/ai-sdlc-factory --input source=github --input repo=OWNER/REPO --input staging_branch=dev` | the first unblocked slice gets `factory-in-progress`; the delivery's approvals; a pull request into `dev` |
| Merge | a person merges the pull request and closes the slice's issue | the next slice is released |
| Verify | `azhi run examples/ai-sdlc-factory-verify --input repo=OWNER/REPO --input staging_branch=dev --input journeys="..."` | a verdict in Slack: every item pass, fail or unavailable; a failure asks for approval before one fix issue is created |

## 3. Failure paths to try once

- Reject the brainstorm: the run ends, no plan, no issue.
- Leave a brainstorm question unanswered: the plan lists it under `open_questions`.
- Make a slice's tests fail: the lap labels it `factory-needs-owner`.
- Reject the delivery's release approval: the run fails and the claim label stays (known limit, see
  [ai-sdlc-factory](../ai-sdlc-factory.md)); remove `factory-in-progress` by hand.
- Run verify with a journey the code cannot support: `fail` with the missing step; with an unreadable one: `unavailable`.
- Check that Slack and the issues contain no secrets and no ticket text run as a command.

Record what differed from this table and fix it in the example, not in this page.
