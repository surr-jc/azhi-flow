# Changelog

## Initial version

- Copy of `openspec-flow` ending in a pull request into `base_branch`, cut from `stack_on`, reviewed by
  `pr-review`, with one fix round and a sign-off instead of a release approval.
- The repository's own test command (the `sdlc-universal` gate) instead of a fixed command.
- `spec_change` carries the check of the round that passed, so later steps do not read a step only one round runs.
- Not run against a live repository yet.
