# Changelog

## Initial version

- OpenSpec lifecycle as a workflow: scan, propose, deterministic check with one fix round, independent spec
  review, spec approval, build, verify, release approval, checked archive, pull request.
- `spec_check.py` validates a change (SHALL/MUST, scenarios, delta operations against the scanned requirement
  names) and proves an archive by postconditions.
- Not run against a live repository yet.
