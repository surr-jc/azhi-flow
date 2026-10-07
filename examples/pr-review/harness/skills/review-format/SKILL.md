---
name: review-format
description: Format of the final PR review (verdict rules, triage of each finding, and Markdown body)
---
# Review format

Verdict:
- `request_changes` when any blocker remains.
- `comment` when only major or minor findings remain.
- `approve` when nothing remains.

Triage every finding into one group (a review is input, not a work order; the author decides):
- `fix_now`: real, and belongs in this pull request. Every blocker is `fix_now`, and so is a major
  finding in code the pull request changes.
- `follow_up`: real but can wait, or is outside what this pull request set out to do (pre-existing
  code, minor polish, a refactor the change does not need). The author files an issue for it
  instead of growing the pull request.
- `check_by_hand`: a person should look or test before trusting it, because the reviewers could
  not verify it from the code alone (runtime behaviour, configuration, performance, UI, an
  external service) or the reviewers disagree. Never use this group to soften a blocker; a blocker
  that also needs a manual check stays `fix_now` and says so in its detail.

Body (Markdown, posted as one PR comment):

```
## Azhi review: <verdict in words>

<one-sentence summary>

### Fix now
| Severity | Where | Finding |
|---|---|---|
| blocker | `path:line` | what is wrong and the fix |

### Follow-up issue
| Severity | Where | Finding |
|---|---|---|

### Check by hand
| Severity | Where | What to check |
|---|---|---|
```

Leave out a group with no findings, and all three when there are none. Order rows by severity.
Keep the body under 60 lines.
