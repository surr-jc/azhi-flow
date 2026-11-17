---
name: adversarial-pr-review
description: Assume the change is broken and find the most likely ways it fails - attack surface, eight failure classes, ranking, and what a probe must prove before a failure is reported
---
# Adversarial PR review

The question is not "is this well built" but "what is the most likely way this change breaks, and can it
be made to break?" A suspicion that was never tried is reported as **unproven**, never as a failure.

The workflow splits the work: you do one stage (map and rank, or write probes). It fetches the PR, runs
the probes with a trusted runner and decides the verdict by rules. Read only what your command names.

## Map the attack surface

Read the diff and the code around it (repo-facts `changed-files`, `file-diff`, `references`), then record:

- **Entry points** the change adds or alters: functions, CLI commands, routes, jobs, migrations, hooks, config keys.
- **Invariants** it relies on: input non-empty, row exists, lock held, caller authorised, old and new code never run together.
- **Trust boundaries** crossed: untrusted input to a sink, user input to a path or query, tenant A to tenant B, secret to a log.
- **State and ordering**: writes commit together, retries are idempotent, events arrive once, the process stays up between steps.
- **Contracts**: public API, wire format, CLI flags, config defaults, schema, error types and status codes.
- **Callers** of every changed exported symbol.

A scenario that does not name its entry point and the invariant it violates is a guess, not an attack.

## Enumerate candidates: the eight classes

Keep a candidate only when it names a concrete mechanism in the changed code (`file:line`).

| Class | Look for |
|---|---|
| `input_boundary` | empty, null, zero, negative, maximum, malformed, unicode, oversized, wrong-typed input reaching changed parsing, validation or arithmetic |
| `trust_boundary` | untrusted input reaching a query, shell, path, template or deserializer; authorisation checked on one path and not another; missing tenant scope; secret in a log or error |
| `state_concurrency` | partial write, non-idempotent retry, duplicate delivery, interleaved requests, crash between two steps, cache and source disagreeing |
| `migration` | existing rows that do not match the new structure, backfill that misses rows, old and new code running together, rollback that cannot restore |
| `compatibility` | an existing consumer of a changed signature, response field, status code, exit code, flag or default; version skew in a rollout |
| `error_handling` | swallowed exception, skipped cleanup, wrong error mapped to the user, retry storm, resource left open |
| `resource_limits` | unbounded growth, missing timeout, N+1, large payload in memory, leak, work proportional to untrusted input |
| `deployment` | flag defaulting on, startup order, shutdown mid-write, missing permission, health check green while the feature is broken |

## Rank and select

Likelihood: **high** when the diff implements the path, a caller reaches it and no test covers it; **medium** when it
needs a specific state or input, or a test misses the case; **low** when nothing reaches it or a guard rules it out.
Impact: **high** is data loss or corruption, authorisation bypass, outage, a wrong money or access decision, an
irreversible change; **medium** is a wrong result on a user path, degraded performance, manual repair; **low** is a
misleading message or an easy workaround.

Select the **3 to 5** highest likelihood x impact scenarios, always including one high-impact scenario even when
its likelihood is medium. More than 5 cannot be probed in the budget. List the rest as deferred, one line each.

## Probes and evidence

Each scenario ends in one state:

| State | Level | Meaning |
|---|---|---|
| reproduced | `L3 - Executed` or `L4 - Reproduced` | a probe ran and the failure was observed (`L4` for a CLI or HTTP surface driven end to end) |
| ruled out | `L2 - Ruled out` or `L3 - Executed` | the failure path was walked and cannot be reached, or the probe ran and the code behaved |
| unproven | none | the decisive probe could not run; name what it needed |

Probe rules (the runner enforces the time limits; you keep to the rest):

- **Non-mutating.** Write only under `.azhi-probes/`. Never edit a tracked file.
- **Disposable state.** A temporary file or in-memory database, never a live database, bucket or queue.
- **No credentials, no production, no network.** A probe that needs them is not written; mark the scenario unproven.
- **No destructive operation**, however sure the outcome. A migration that drops data is reviewed by reading.
- **Minimal and deterministic.** The smallest call that shows the behaviour, asserting one observable
  (exit code, exception type, response body, row count), not "it looked wrong".

## Verdict (decided by the workflow, not by you)

- **breaks**: at least one failure reproduced that a user, caller or operator can hit, and an independent check agreed.
- **unproven**: nothing reproduced, and at least one decisive scenario was not executed.
- **holds**: at least one probe executed and passed, the rest were ruled out, and nothing decisive is unproven.
  It does not mean the change is correct, only that the attacks tried did not land. A diff with no executable
  surface (docs or comments only) holds, and the report says "nothing executable changed".

Severity of a reproduced failure: `MUST` (data loss or corruption, trust-boundary bypass, outage, a wrong money
or access decision), `SHOULD` (wrong result on a user path, or manual repair), `MAY` otherwise. A `MUST` that could
not be executed is unproven, not a blocker.
