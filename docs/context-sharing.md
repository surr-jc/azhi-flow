# Context sharing between steps

Nodes already share data through explicit refs (`ref: nodes.X.output.field`, CEL). This page covers
the opt-in mechanisms that make sharing cheaper and safer. Each ships on its own; sections are added
as they land. Plan and decisions: `.claude/plans/node-context-sharing.md`.

| Mechanism | Status |
|---|---|
| Input cap (`context_budget`) | built |
| Workspace continuation (`workspace.from`) | planned |
| Context bundles (`contexts:` / `context:`) | planned |

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
