# Dev workflow: how the portable `.claude/` layer maps to AI-SDLC v2

The layer itself is repo-agnostic: see [.claude/README.md](../.claude/README.md). This page is only the
Azhi-specific adapter notes (stage mapping and the gap with v2). Azhi's commands live in `CLAUDE.md`.

The `.claude/` folder is adapted from [ai-native-starter-pack](https://github.com/coleam00/ai-native-starter-pack)
(MIT, same PIV source as `sdlc-implement`). It is the interactive, in-editor layer. `examples/ai-sdlc-v2`
is the governed, unattended layer. Both read the same ticket shape and follow the same stages.

```
/intake (Jira | GitHub | Confluence) -> /plan-feature -> approve -> /execute -> /validate
   -> /code-review -> /code-review-fix -> /commit        later: /rca, /system-review
```

## Stage map

| Stage | Claude Code skill | ai-sdlc-v2 node | Tier |
|---|---|---|---|
| Intake | `intake` (+ `prime` step 0) | `source`, `github_issue`, `intake` | haiku |
| Ready check | `plan-feature` flags gaps | `dor_check`, `dor_gate` | opus |
| Requirements + design | `plan-feature` | `plan`, `design_review` | opus |
| Build | `execute` | `build` (engineer) | sonnet |
| Tests / typecheck | `validate` | `preflight`, `build_static` | haiku |
| Review | `code-review` | `lite_review_1`, `lite_verify_1` | sonnet (opus if sensitive) |
| Fix | `code-review-fix` | `lite_fix` | sonnet |
| Commit | `commit` | `push_branch`, `open_pr` | haiku |
| Learn | `rca`, `system-review`, `execution-report` | `retro` | opus / haiku |

## Intake compatibility

`/intake` writes `.claude/work/<KEY>/ticket.json` with exactly the nine fields of `ticket.normalize`
(`source, key, title, description, priority, reporter, status, labels, url`) and the same caps
(title 200, description 20,000, 50 labels). That file can be used as the ticket for a v2 run.

- **GitHub:** `gh issue view` (same data as `github.get-issue`: body plus first 20 comments).
- **Jira:** Atlassian MCP (`.mcp.json`, OAuth on first use).
- **Confluence:** excerpts, max 5 pages, folded into `description` under `## Linked Confluence context`.
  The engine has no Confluence tool, so this is the only place it appears; v2 sees it as ticket text.

**Unattended counterpart:** [`examples/sdlc-universal`](../examples/sdlc-universal/README.md) is the Azhi
workflow built from this layer. It reads Jira and GitHub (and one Confluence page), runs on Anthropic,
GitHub Copilot or ChatGPT-plan models through OpenCode, and finds the repository's test commands itself.
`ai-sdlc-v2` stays GitHub-only and Azhi-specific.

## Model tiers and token rules

See [.claude/README.md](../.claude/README.md). Azhi's own profiles pick models per role and let each reviewer use a different model so they do not share
blind spots (`docs/model-defaults.md`). Keep that when mapping tiers.
