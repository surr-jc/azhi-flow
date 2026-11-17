---
name: probe-protocol
description: How to write a probe the runner can execute (manifest, probe file, REPRODUCED or HELD line) and how to report scenarios you cannot probe
---
# Probe protocol

You have no shell. You write files; after you submit, a trusted runner on the worker runs them in this
checkout and records the result. You will not see the output, so the probe must decide for itself.

For each scenario you can execute, create `.azhi-probes/<id>/probe.json` and the probe file next to it:

```json
{"id":"P1","kind":"cli","argv":["node",".azhi-probes/P1/probe.mjs"]}
```

- `id` equals the folder name and the scenario id (`P1` to `P5`). `kind` is one of `library`, `cli`, `http`,
  `job`, `migration`, `concurrency`. `argv` is the program and its arguments, no shell syntax (no `&&`, pipes,
  globs, redirects, quotes meant for a shell). Paths are relative to the checkout root.
- The message carries a `strategy` for this repository: take `argv` from its `launch.argv` (with `{probe}` replaced
  by your probe file's path), the file name from `launch.file`, and stay within its `seams` and out of its `avoid`.
- Use the language the project already has (its test runner, fixtures and fakes are the best seam). Import the
  changed code from the checkout; do not copy it.
- The probe's **last line of stdout** is the verdict: `REPRODUCED: <the observable that went wrong, with the
  actual value>` or `HELD: <what the code did instead>`. Assert one specific observable (exit code, exception
  type, response body, row count), compute the line from it, and never print `REPRODUCED` on a crash you did
  not expect: a crash that is not the scenario's failure is not a result (the runner then records `not_run`).
- Exit 0 whichever line you print. Print nothing secret.
- Write only under `.azhi-probes/`. Never edit, create or delete anything else; the workflow flags a change
  anywhere else and throws the probes away. Use a temporary file or an in-memory store for state.
- No network, no live credentials, no package installs, no destructive operation. A limit of 10 minutes per
  probe and 25 in all is enforced; keep a probe to seconds.
- Keep each probe under 80 lines: the author reads it to rerun it.

A scenario you cannot or should not execute (deployment, rollout order, anything needing a service or
credential, a toolchain you saw is absent) gets **no files**. Report it with `mode: static`: walk the code
and say `ruled_out` (with the walked path in `reason`, citing `file:line`) or `unproven` (name what runtime
evidence it needs). Never mark a scenario ruled out because you could not make it fail by reading alone when
it is decisive: that is `unproven`.
