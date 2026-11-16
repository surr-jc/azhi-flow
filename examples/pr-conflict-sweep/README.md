# PR conflict sweep: every conflicting pull request in a repository, resolved one after the other

Adapted from the [`resolve-pr-conflicts`](https://github.com/tomzx/agents/blob/main/skills/resolve-pr-conflicts/SKILL.md)
skill. It lists the open pull requests GitHub reports as conflicting and runs the published
[`pr-conflict-resolver`](../pr-conflict-resolver/README.md) on each. Each resolution is checked (tests on the base, the
pull request and the result, an independent review) and waits for a person's approval, then goes to a new `azhi/`
branch and a pull request into the contributor's own branch. Nothing is merged, closed or force-pushed.

## Before you start

| Needed | How |
|---|---|
| The **pr-conflict-resolver** published, with the same repository | `azhi example install pr-conflict-resolver --repo OWNER/REPO`, then publish it. It carries its own tools and secrets. |
| **GitHub read access** for the list | Secret `github-read-token` (Pull requests: read), or `azhi github login`. |
| The repository named on the tool | Install from the marketplace and name it, or edit `repos` in `azhi.config.yaml`. |

## Run it

```bash
azhi run examples/pr-conflict-sweep -i repo=OWNER/REPO -i dry_run=true   # only list them
azhi run examples/pr-conflict-sweep -i repo=OWNER/REPO -i limit=5
```

| Input | Default | Meaning |
|---|---|---|
| `repo` | | `owner/name` |
| `limit` | 5 | Most pull requests to resolve (1 to 20), oldest first |
| `author` | everyone | Only this GitHub login's pull requests |
| `resolve_draft` | off | Include drafts |
| `dry_run` | off | List and summarize only; no child run, nothing posted |

## What happens

1. **List.** Open, from this repository (not a fork), `mergeable_state` dirty, oldest first. A pull request whose
   mergeability GitHub has not computed yet is listed as *unknown*, never as clean: run the sweep again later.
2. **Resolve.** One child run of `pr-conflict-resolver` per pull request, one after the other. A child that is
   rejected at its approval, expires or fails does not stop the sweep.
3. **Summary.** Each pull request with its result: `resolved` (with the resolution pull request), `needs_manual`
   (the resolver commented why), `skipped`, `failed` or `not_tried`.

## Differences from the skill

| Skill | This workflow |
|---|---|
| Resolves in parallel, one agent per worktree | One at a time: every child runs the tests on a worker and waits for its own approval |
| Pushes the merge to the head branch | Never touches the contributor's branch; opens a pull request into it after approval |
| Fork pull requests via the fork URL | Forks are skipped |
| `--concurrency`, `--limit` | `limit` only |
| Verification optional (`no-verify`) | The resolver's `inconclusive` result opens a draft |

## Known limits

- A sweep of N pull requests can take N approvals, so it may run for days (each child may wait up to 96 hours).
- At most 100 pull requests are checked for conflicts per run; `truncated` says when there were more.
- Merge each resolution pull request with a **merge commit** (see the resolver's README).
