# Local workspaces

An OpenCode step normally works in a fresh clone that is deleted when the step ends. With a **local
workspace** the run works in a git worktree of a repository you already have on the worker's machine. The
worktree stays after the run, so you can open it in VS Code from the run page and carry on from there.

Use it when Azhi runs on your own machine (`azhi up`) and you want the agent's change in your editor, not
only as a diff in the browser.

## Turn it on

It is off by default, in three places:

1. **The worker.** Start it with local folders allowed:

   ```bash
   azhi up --local-folders
   ```

   (`azhi worker start --local-folders`, or `AZHI_LOCAL_FOLDERS=1`.) A worker started without it never
   opens a local folder.

2. **The folder.** An admin registers it on the Workers page, under *Local folders*: a name and the
   absolute path of the top folder of a git repository. The path is on the worker's machine. It is typed,
   because a browser cannot hand over a folder's full path.

3. **The workflow.** A step names the folder:

   ```yaml
   - id: implement
     type: agent
     executor: opencode
     profile: coder@1
     workspace:
       local: shop          # the registered name, never a path
       ref: main            # optional; HEAD when absent
       mode: write          # optional; the agent may edit
       test: {command: "npm test"}
     output_schema: schemas/out.json
   ```

`local` is a literal name. It cannot be a value, an input or an expression, so the path never comes from
workflow, ticket, issue or pull request text. It is not combined with `repo`, `host`, `credential`, `depth`,
`merge_ref` or `from`; `ref`, `base_ref`, `mode` and `test` work as they do for a clone.

The run plan lists two requirements for the step, *local folder <name>* and *worker allows local folders*,
and blocks the run when either is not met. Its policy coverage marks *works in a local folder* as
**unobservable**: the gateway cannot see what is read or written there.

## What the run does

- The first step that names the folder makes a worktree at
  `~/.azhi/worker/worktrees/<run id>-<name>`, on a new branch `azhi/<run id>`, starting from `ref`.
- Every later step of the run that names the folder works in the same worktree, so it sees the earlier
  steps' files. Steps of one run take turns in it.
- After a `mode: write` step the worker commits the change to the run's branch (`azhi: <step id>`). The
  step's `workspace` output is the run's whole change so far, measured from the commit the run started from.
- Your repository gains that branch and nothing else. Its own working tree, `HEAD` and uncommitted files are
  not touched.
- Nothing is merged, pushed or deleted.

Git runs as it does for a clone: no host git config, hooks and `core.fsmonitor` off, so nothing in the
repository's settings starts a program during a step.

## Open it

The run page shows **Open in VS Code** once the first step has made the worktree, and a *Worktree* panel
with the folder, the branch and the commit it started from. The button is a `vscode://file/<path>` link, so
it works when the browser and the worker are on the same machine and VS Code is installed.

## Remove it

A worktree is never removed for you. On the worker's machine:

```bash
azhi worktree list
```

```bash
azhi worktree remove <run id>
```

Git refuses to remove a worktree with uncommitted or untracked files; add `--force` to remove it anyway.
The branch `azhi/<run id>` is left in your repository. Delete or merge it yourself.

## Limits

- **Filesystem isolation is not enforced.** A clone is a temporary folder that disappears; a worktree is a
  real folder on your machine. OpenCode still may not run a shell or leave the worktree.
- **The test command runs repository code on your machine**, as it does for a clone. Use a worker you would
  trust as a CI runner for the repository.
- **The worktree holds code written by an agent.** VS Code's Workspace Trust applies when you open it. The
  worktree's `.git` pointer file is inside the folder the agent edits; the worker never follows it and puts
  it back after each step, but do not rely on the folder's git state while a step is running.
- **Symbolic links** in the repository are checked out as plain files, so your own git shows them as changed
  in the worktree.
- **One machine.** The path is the worker's. Remote workers and VS Code Remote are not supported.
- **No push.** The existing gated write tools take a remote repository; a run branch in a local folder is
  yours to push.
- A step that is killed can leave a lock beside the worktree. It is ignored after 12 hours, and
  `azhi worktree remove` clears it.
