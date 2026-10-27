# Issue root-cause analysis with an OpenCode agent

`examples/issue-investigation` diagnoses one GitHub issue before anyone fixes it. An OpenCode agent
works in a fresh checkout of the repository, finds where the reported behaviour comes from and
since when, and returns an evidence-backed root-cause analysis (RCA). Posting it on the issue is
optional and waits for a person to approve the exact text.

```
issue ─ investigate (OpenCode, checkout) ─ challenge (second model, own checkout) ─ calibrate ─┬─ report
                                                                                              └─ should_post ─ approve_post ─ post
```

`challenge` tries to refute the analysis (every evidence line, a competing explanation, the fix).
`calibrate` sets the confidence to trust: `high` only when the investigator says high **and** the
challenger supports the analysis with at least `config.min_confidence` (80); `low` when it is refuted or
the investigator is unsure. A refuted analysis is never posted. See [docs/confidence.md](confidence.md).

| Node | What it does |
|---|---|
| `issue` | `github.read-issue@1`: title, body, labels, author and the first comments |
| `investigate` | OpenCode agent in its own checkout of the default branch (or the run input `branch`), returning `schemas/rca.json` |
| `challenge` | OpenCode agent (`root-cause-challenger@1`, `gpt-5.6-terra`) in its own checkout: returns `supported`/`partly_supported`/`refuted`, a 0 to 100 confidence, an evidence check per cited line, the competing explanation and corrections (`schemas/challenge.json`) |
| `calibrate` | Condition: the confidence to trust (`high`, `medium`, `low`) from both agents; shown in the report, the approval and the posted comment |
| `report` | The RCA as a run artifact (`templates/rca.md`) |
| `should_post` → `approve_post` → `post` | Only when the run input `post` is true: a person approves the comment (the approval message shows the confidence), then `github.comment-on-issue@1` posts it. Ledgered and deduplicated; its CEL guard only allows the issue under investigation |

## What the RCA holds

- `assessment`: severity (critical/high/medium/low), complexity (low/medium/high) and confidence
  (high/medium/low), each with a one-line reason. Low confidence means a person should look before
  any fix runs.
- `origin`: regression (with the commit), long-standing, original behaviour, or unknown.
- `root_cause` and `evidence`: the 5-whys chain, each link with a `path:line`.
- `fix`: strategy, files and the change in each, alternatives, risks; `tests` to add; `out_of_scope`.
- `comment`: the Markdown posted on the issue.

## The investigator's setup

```yaml
harness:
  opencode:
    agent: harness/agents/investigator.md
    command: harness/commands/investigate.md
    skills: [harness/skills/root-cause-analysis]
    tools: [read, grep, glob, skill]
    mcp:
      repo-history: {command: [node, harness/mcp/repo-history.mjs]}
```

- **Skill** `root-cause-analysis` is adapted from Cole Medin's `piv-investigate-issue`
  ([coleam00/skills](https://github.com/coleam00/skills), MIT; `LICENSE` and `SOURCE.md` sit next
  to it). The method is the original's: map where the code lives and how it works, find when it
  changed, chain the 5 whys with evidence, assess with reasons, propose the fix and its tests. The
  `gh`/`git` commands and file writes were removed (Azhi reads the issue with a gateway tool,
  history comes from the MCP server, and the comment is a separate approval-gated step).
- **repo-history** is a dependency-free stdio MCP server that runs only `git log`, `git blame` and
  `git show` in the checkout: `recent-commits` (optionally for one path), `blame` (up to 200
  lines), `search-history` (`git log -S`, when a string appeared or disappeared) and `show-commit`.
  Paths must be repository-relative and SHAs hex, so arguments cannot become git options. Like
  every MCP server, the run plan marks it unobservable.
- The checkout is the same isolated workspace as the PR review example (see
  [pr-review.md](pr-review.md#the-isolated-checkout-workspace-on-an-agent-node)): fresh folder,
  token only in the fetch, host git config ignored, symlinks as plain files, deleted after. It
  fetches full history by default, which `blame` and `search-history` need; add `depth` to the
  workspace for very large repositories at the cost of older history.

## Setup

```bash
azhi example install issue-investigation --repo OWNER/REPO   # or Mission Control > Examples; --api-url for GHE
azhi copilot login                                           # or Secrets > Sign in with GitHub Copilot
azhi secret set github-read-token                            # read-only Contents + Issues
azhi secret set github-comment-token                         # Issues: write, only if you post
azhi run <version-id> --published -i repo=OWNER/REPO -i issue=42 -i post=false --wait
```

Add `-i branch=release/2.3` to investigate a branch other than the default one.

The tools have their own ids (`github.read-issue`, `github.comment-on-issue`), so installing this
example does not change the repositories the SDLC example's `github.get-issue` may read.

## Verified

`test/issue-investigation.test.ts` runs OpenCode for real against a scripted model endpoint, a
local git host and a fake GitHub: the history tools find the regression commit on the default
branch, a named branch is checked out instead when given, bad arguments are refused, the RCA and
report come out as structured, and the comment is posted only after approval. Not yet run against a
live model or github.com.
