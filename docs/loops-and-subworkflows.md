# Loops and subworkflows

Both node types were in the schema from the start but did not run. This is what they do now. The
exact semantics below were chosen when they were built (the product spec text was not available to
check), so confirm them against spec v2.x before relying on them.

## Loop

Repeats one tool or script step, one iteration after another.

```yaml
- id: refine
  type: loop
  initial: {n: 0}              # `state` in the first iteration
  max_iterations: 5            # 1 to 1000
  exit: "state.n >= 3"         # CEL, checked after every iteration
  on_max: fail                 # or continue; default fail
  node:
    type: script              # or tool
    runtime: python
    entrypoint: scripts/step.py
    input: {map: "{'n': state.n}"}
```

- Inside `node`, `state` is the previous iteration's output (`initial` the first time) and
  `iteration` is the 0-based index. In `exit`, `state` is the output just produced and `iteration`
  is the number of iterations completed.
- Output: `{state, iterations, count, exited}`. `exited` is false only when `on_max: continue` let
  the loop end at the limit. With the default `on_max: fail` the node fails with a
  `contract_violation` instead.
- Each iteration is an ordinary script attempt (id `refine[i]`) or tool call with its own ledger
  ordinal, so writes inside a loop are deduplicated per iteration. Tool and script retries apply per
  iteration.
- Taint: a loop over a tool is as trusted as that tool's output.
- Not supported: agents as the loop body (an agent's transcript is keyed by node, not iteration),
  and several steps in one body (use a subworkflow for that).

## Subworkflow

Runs a published workflow as a child run.

```yaml
- id: review
  type: subworkflow
  workflow: doubler            # a workflow id, or id@version
  input: {x: 21}
```

- The child is a run of its own: its own plan, ledger, run page and context manifests, started as a
  Temporal child workflow of the parent run. Cancelling the parent cancels the child.
- It resolves to the latest published version when the node starts (the run plan shows which), runs
  as the parent run's principal, and is created once per parent node, so a retry reuses it.
- Output: `{run_id, workflow, version, state, nodes}` where `nodes` maps each succeeded child node
  to its output, so `nodes.review.output.nodes.double.doubled` reads a child result. If the child
  does not end `succeeded`, the node fails with the child's error class.
- Taint: the output is treated as untrusted, since the child may call tools and agents the parent
  cannot see into.
- Guards: a workflow cannot call itself directly or through its chain, and nesting stops at four
  levels. The run plan shows a blocker (`subworkflow_missing`, `subworkflow_recursion`) for a
  target that is not published or that calls itself.
- `parallel` fan-out of subworkflows and quorum joins are not built.
