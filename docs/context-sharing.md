# Context sharing between steps

Nodes already share data through explicit refs (`ref: nodes.X.output.field`, CEL). This page covers
the opt-in mechanisms that make sharing cheaper and safer. Each ships on its own; sections are added
as they land. Plan and decisions: `.claude/plans/node-context-sharing.md`.

| Mechanism | Status |
|---|---|
| Input cap (`context_budget`) | built |
| Workspace continuation (`workspace.from`) | built |
| Context bundles (`contexts:` / `context:`) | planned |

## Workspace continuation

`workspace.from` starts a checkout from an earlier step's change, so a later agent sees the files an
earlier one wrote instead of only a diff as text.

```yaml
- id: build
  type: agent
  executor: opencode
  profile: engineer@1
  workspace: {repo: {ref: inputs.repo}, ref: HEAD, credential: github-read-token, mode: write}
  output_schema: schemas/change.json
- id: review
  type: agent
  executor: opencode
  profile: reviewer@1
  workspace:
    repo: {ref: inputs.repo}
    ref: HEAD                       # only labels the result; the change's own base is what is checked out
    credential: github-read-token
    from: {ref: nodes.build.output.workspace}
  output_schema: schemas/verdict.json
```

- **A plain ref.** `from` must be `{ref: nodes.<step>.output...}` to a workspace change: the
  `workspace` field of a write-mode step, or any step whose output has `base_sha` and `files` (for
  example a script that picks one of several builds). A CEL expression, a map, a literal or a ref to
  `inputs` is `workspace_from_invalid`; a ref of the wrong type is `workspace_from_type`; a producer
  with no declared output type is `workspace_from_untyped` (a warning, checked when the step runs).
  `base_ref` together with `from` is `workspace_from_base_ref`. It orders the steps like any data ref.
- **The change's own base.** The worker fetches the commit the change was made against
  (`base_sha`), not the step's `ref`, so a branch that moved during a long run does not fail the
  step. The commit must still be fetchable by SHA: GitHub serves any commit reachable from a branch
  or tag; a commit that was force-pushed away may be gone, and a self-hosted git server must allow
  fetching by SHA.
- **Applied as a local commit.** The files are written (added, modified, deleted, binary, the
  executable bit) and committed locally; `refs/azhi/base` points at the base, so tools that diff
  commits (`refs/azhi/base...HEAD`) see the change. Nothing is pushed.
- **Read and write mode.** In read mode the agent inspects the files. In write mode it builds on
  them, and the change it returns is the **total** from the real base (`base_sha` stays a commit that
  exists on the remote), so a later step or a push tool needs no special handling.
- **Safe by construction.** The change is data an agent wrote, so the worker checks every path before
  writing: no absolute paths, `..`, backslashes or control characters; nothing in `.git`; no Windows
  reserved names, `:` or trailing dots and spaces; no case-insensitive duplicates, no file that is
  also a folder, no write through a symbolic link; at most 300 files and 1 MB of content. A change
  that does not match its base (adding a file that exists, modifying one that does not) fails the step.
- **Not copied through history.** The workflow carries only the ref. The server reads the change from
  the producing step's stored output, keeps the files and the base as an artifact, and the worker
  fetches that with its run token. The activity input contains no file content.
- **The agent is told.** The prompt gets one generated paragraph: which step's change the checkout
  holds and up to 12 file names (quoted, shortened, given as data). Skills written for a fresh base
  checkout should say the folder now contains the change (ai-sdlc's reviewers do).
- **Workers.** A worker advertises the `workspace_continuation` feature. A step that continues is
  only given such workers; the others are refused with "worker build does not support workspace
  continuation; upgrade it", and the run plan shows a requirement row and a coverage row.
- **Executors.** OpenCode only (both adapters). Other executors keep the `workspace_unsupported` error.
- **Test runs.** A test run of one step has only fixtures for upstream outputs, so the change is taken
  from the fixture.

### Deployment note

Publish a workflow that uses `workspace.from` only after **every server instance and worker** runs a
build that has it. Worker gating refuses an old worker, but a run is pinned to the interpreter build
that created it, and an older interpreter would drop the field and check out the bare base.

## Input cap

`context_budget` on an agent node limits the bytes of input that reach the model.

```yaml
- id: review
  type: agent
  profile: reviewer@1
  input: {ref: nodes.change.output}
  output_schema: schemas/verdict.json
  context_budget:
    max_item_bytes: 65536     # per top-level input field, at least 256
    max_input_bytes: 200000   # the whole input, at least 1024
    on_exceed: fail           # or withhold; default fail
```

- **Exact bytes.** The size is the UTF-8 length of the JSON encoding, measured after artifact
  handles and deferred refs are expanded (a handle would otherwise count as a few bytes). It is not a
  token estimate: a token cap would rest on a guess.
- **`on_exceed: fail`** (default). The step stops with `budget_exceeded` before any model call. The
  message names the node, the field and both numbers.
- **`on_exceed: withhold`.** Fields over `max_item_bytes` are replaced by a note, a size and a
  SHA-256; then, while the whole input is still over `max_input_bytes`, the largest remaining field
  goes the same way (ties by field order). If the input is still over the cap with every field
  withheld, the step fails. An input that is not an object (a string or an array) is measured whole
  and cannot be partly withheld.
- **Withheld means unreadable.** The agent is told it cannot read the field and to say so if it
  matters. It has no tool to read upstream outputs. Do not withhold the field a verdict depends on:
  a reviewer that never saw the diff can still "approve" it, so people are shown what was left out.
- **Recorded, never stored again.** The value already exists as an upstream output, so the context
  manifest keeps only its hash and size (also when `AZHI_STORE_CONTEXT_CONTENT=1`). The run gets a
  `run.context_withheld` event for the node with the fields, and a `context_withheld` flag listing
  `node.field`, shown as a badge on the run page.
- **Every executor.** The cap is applied where the context is built, so it covers the built-in
  model agent and all harness executors (OpenCode, Claude Agent SDK, Codex).
- **Retrieval is unchanged.** A node with `datasets` still builds its retrieval query from the whole
  input as resolved, before the cap.

### Server default

Set `AZHI_CONTEXT_MAX_ITEM_BYTES` and/or `AZHI_CONTEXT_MAX_INPUT_BYTES` to cap every agent step in
the deployment. Both are unset by default. A node's own `context_budget` overrides each limit; the
server default always fails (it never withholds). A value that is not a whole number of bytes at or
above the minimum is ignored, with a warning at startup.

### Where it shows

- The run plan has an `input cap` coverage row on every capped agent: the limits and the mode.
- The editor has an **Input cap** section on agent steps.
- The workflow builder knows the key and offers it for steps whose input can be large.

### Deployment note

Publish a workflow that uses `context_budget` only after **every server instance** runs a build
that has it. A run is pinned to the interpreter build that created it, and an older server rejects
the key at upload (fails closed), but a run already started on an older interpreter would ignore it
(fails open on cost).
