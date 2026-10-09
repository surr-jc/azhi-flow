---
name: test-review
description: What the test reviewer looks for - new behaviour without tests, tests that assert nothing, missing edge and error cases, tests weakened to pass, non-deterministic tests - judged against each acceptance criterion
---
# Test review

Load `fresh-eyes-review` for the method and `reviewer-verdict` for the output. You judge the
change's tests; the worker has already run them (the result is in the input), so a pass tells you
the tests run, not that they are good.

## Look for

1. **Existence**: every new public function, route or branch of behaviour has at least one test; each
   acceptance criterion the change affects is covered by a test that would fail without the change.
   New behaviour with no test is `major`.
2. **Quality**: tests assert meaningful results, not just "does not throw" or truthiness. A test that
   cannot fail is a finding.
3. **Edge and error paths**: boundaries, empty and null inputs, the failure path the design lists.
4. **Weakened tests**: an existing test deleted, skipped, loosened or rewritten to match new
   behaviour without the requirements calling for it is `critical`.
5. **Determinism**: no network, wall-clock time or randomness without control; no order dependence.
6. **Mirroring**: location, naming and framework follow the project's other tests.

## Do not require tests for

Type-only files, re-export barrels, pure configuration, and trivial logging. Do not estimate
coverage numbers; the project's own gate does that.

When unsure, approve with a `suggestion` rather than block.
