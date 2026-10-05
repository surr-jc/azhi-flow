---
name: review-format
description: Format of the final PR review (verdict rules and Markdown body)
---
# Review format

Verdict:
- `request_changes` when any blocker remains.
- `comment` when only major or minor findings remain.
- `approve` when nothing remains.

Body (Markdown, posted as one PR comment):

```
## Azhi review: <verdict in words>

<one-sentence summary>

| Severity | Where | Finding |
|---|---|---|
| blocker | `path:line` | what is wrong and the fix |
```

Leave the table out when there are no findings. Keep the body under 60 lines.
