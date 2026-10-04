# Quality guidelines

These guidelines explain how the team reads its weekly quality numbers.

## Pass rate

The pass rate is the share of CI runs on the main branch that succeed. Below 90 percent the
team pauses feature merges until the cause is understood.

## Flaky tests

A test is flaky when it fails and then passes on the same commit without a code change.

### Quarantine

Flaky tests are quarantined within one working day. A quarantined test still runs but cannot
block a merge. Each quarantine needs an owner and a ticket.

### Flake rate

The flake rate is the share of failures caused by flaky tests. A rising flake rate usually
points at shared test infrastructure, not at product code.

## Mean time to green

Mean time to green measures how long main stays red after a failing run. Anything above two
hours is raised in the weekly review.
