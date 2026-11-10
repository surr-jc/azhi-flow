# Changelog

## Auto mode

- `mode: auto` decides the specs approval and the sign-off by rules when it is safe (`specs_gate`,
  `signoff_gate`), asks a person otherwise and says why, and posts each decision taken without a person to Slack.
- Open questions are now `{question, recommendation, why}` objects; the approval notes default to the
  recommended answers when left empty. Supervised mode is otherwise unchanged.
- `specs_decision` and `signoff_decision` join the person and the rules for the steps after them.

## Initial version

- Copy of `openspec-flow` ending in a pull request into `base_branch`, cut from `stack_on`, reviewed by
  `pr-review`, with one fix round and a sign-off instead of a release approval.
- The repository's own test command (the `sdlc-universal` gate) instead of a fixed command.
- `spec_change` carries the check of the round that passed, so later steps do not read a step only one round runs.
- Not run against a live repository yet.
