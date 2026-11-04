# OpenSpec flow

Spec-driven delivery on the OpenSpec layout: a GitHub issue becomes an `openspec/changes/<id>/` folder
(proposal, delta specs, tasks), a script and an independent reviewer check it, a person approves the specs,
the tasks are built with tests, the code is verified against the specs, a person approves the release, the
delta specs are merged into `openspec/specs/` and the folder is archived (checked by a script), and one
`azhi/` branch and pull request are opened.

```bash
npx azhi example needs openspec-flow
npx azhi example install openspec-flow --repo OWNER/REPO --set slack_channel=C0123ABCD
npx azhi run examples/openspec-flow -i source=github -i ticket=OWNER/REPO#42 -i repo=OWNER/REPO -i base_branch=dev
```

If the repository has no `openspec/` folder the author creates `openspec/config.yaml` and `openspec/specs/`.
Edit the `apply` step's `workspace.test.command` for the repository's own test command.

Design, the step graph and how the archive is verified: [docs/openspec-flow.md](../../docs/openspec-flow.md).
