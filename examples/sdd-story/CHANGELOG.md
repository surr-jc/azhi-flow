# Changelog

## Source files

- `source: files` takes the Story from `story_key`, `story_title` and `story_body` for a release run without a
  tracker: nothing is read from or written to a tracker. `ticket` is required only for `github`.
- `extra_files` (up to 3 Markdown files under `docs/release/<release>/`) are added to the pull request by both
  pushes (`push_files`, `push_fix_files`); invalid ones are left out and listed in the sign-off payload.
- The tool step `intake` is now `intake_github`; `intake` is a script that joins it with `files_ticket`, so
  `nodes.intake.output.*` reads as before. `label_ticket` runs behind `label_choice` (github only) and
  `story_notify` waits for `signoff_decision`. `github` behaves as before.

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
