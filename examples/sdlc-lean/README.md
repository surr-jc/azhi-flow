# SDLC lean

A ticket (GitHub or Jira, plus an optional Confluence page) to a reviewed pull request in about five model turns.
It is `sdlc-universal` with the steps a simple change does not need taken out.

| Step | Agent? | What it does |
|---|---|---|
| Intake | no | Reads the ticket; gives the git-safe branch name part (`owner/repo#1` becomes `owner/repo-1`) |
| Preflight | yes, no tool calls | Runs the repository's own tests on the untouched base branch |
| Plan | yes | Requirements, design, open questions and the risk, in one pass |
| Design approval | a person | Answers the open questions and confirms the design |
| Build | yes | Implements the plan; the worker then runs the tests |
| Review | yes | One independent reviewer |
| Verify | yes, only on a critical or major finding | Tries to refute the finding |
| Fix | yes, once, only when needed | One fix round, then a second review |
| Release approval | a person | Reads the evidence and approves the exact change |
| Push and pull request | no | Pushes `azhi/<branch>` and opens a pull request into the base branch |

Taken out against `sdlc-universal`: the separate ready check (the plan lists open questions), the test-strategy and
static-checks ladder, building without tests, and the criteria audits. **If the base branch fails its own tests the
run stops and says so; it never builds untested.** A repository needs a test command the gate can find (for Python a
`requirements.txt` or `pyproject.toml` with a `pytest.ini`, `tests/` directory or `[tool.pytest]` section).

Setup is the same as `sdlc-universal`: `azhi example install sdlc-lean --repo OWNER/REPO --set slack_channel=C0123ABCD`.
Slack is best effort: if a post fails the run ends `delivery_failed`, but the pull request and the retro are already done.
