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
- Taint: a loop over a tool is as trusted as that tool's output. A `guard` in the body runs before every
  call and counts as the write's gate, in a `parallel` body too; the compiler checks it like any other guard.
- A `node` loop cannot hold an agent or several steps (an agent's transcript is keyed by node, not
  iteration). Use a `body` for that.

### Several steps: `body`

Repeats several steps, agents included. The compiler writes the rounds out as ordinary steps, so taint
checks, the run plan, the ledger and resume treat them like any other step, and a resumed run keeps the
rounds that finished.

```yaml
- id: attempt
  type: loop
  max_iterations: 2
  on_max: continue             # or fail; default fail
  initial:
    change: {ref: nodes.triage.output.change}
    feedback: null
  body:
    - {id: resolve, type: agent, profile: resolver@1, workspace: {from: {ref: state.change}, ...}, input: {map: "{'feedback': state.feedback}"}, ...}
    - {id: review, type: agent, profile: reviewer@1, ...}
  overrides: {2: {resolve: {profile: resolver@2}}}
  exit:                        # the first that holds ends the loop; none means another round
    - {when: nodes.review.output.prompt_injection_detected, outcome: stop, reason: Prompt injection reported}
    - {when: nodes.review.output.approved, outcome: done, reason: Review approved}
  next:                        # the next round's state, reading this round; a key left out keeps its value
    change: {ref: nodes.resolve.output.workspace}
    feedback: {cel: nodes.review.output.findings}
```

- Each round becomes `attempt_1_resolve`, `attempt_2_resolve` and so on, plus a gate `attempt_1_gate` that
  applies `exit`. Inside the body, `nodes.<step>` means this round's step, `state.<key>` this round's state and
  `iteration` the 0-based round. In `exit`, `iteration` is the number of rounds completed.
- Later steps read only `nodes.attempt.output`, never a round's steps: `{outcome, reason, count, exited, last, rounds}`.
  `outcome` is `done`, `stop`, `no_progress` or `exhausted`. `last.<step>` is the output from the last round, null if
  that round skipped the step. `rounds` lists every round that ran. A large result is stored as one artifact.
- Out of rounds with `on_max: fail` fails the run with `contract_violation`. `stop` and `no_progress` do not fail it:
  later steps decide. An `exit` rule that reads a step its round can skip needs its route checked first, as rules are
  tried in order.
- A plain `{ref: state.x}` stays a plain ref when `x` is one, so `workspace.from` works. `has(state.x)` works only
  when `x` is a plain ref, and a rule or input can always compare it with `null`.
- A `context` in the body gets its own copy per round, so a bundle can read the round's steps and state.
- `GET /v1/runs/:id` returns `loops`: per round its outcome, fixed reason, step states and usage (null when unknown).
  A failed run has it too. The reason is text the author wrote, never ticket or repository text.
- Not supported in a body yet: approvals, notifications, `parallel` and nested loops.

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
- The parent's run page shows the child under its step: state, a link, and an expander with the child's
  steps (nested further for its own subworkflows). The Runs list hides subworkflow runs by default;
  "Show subworkflow runs" lists them as rows with a link back to the parent. `GET /v1/runs?top_level=true`
  does the same, and `GET /v1/runs/:id` returns `children`.
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
