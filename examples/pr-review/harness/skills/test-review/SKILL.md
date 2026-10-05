---
name: test-review
description: What to check in a pull request's tests and style
---
# Test review

- Every new branch of behaviour has a test that fails without the change.
- Tests assert outcomes (returned values, stored rows, responses), not private calls.
- No sleeps or real network in unit tests; time and randomness are injected.
- Names follow the surrounding code; no dead code or commented-out blocks left behind.
