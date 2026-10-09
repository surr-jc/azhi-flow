# AI-SDLC feature delivery (lite or full)

`examples/ai-sdlc` takes one ticket to an opened pull request like [sdlc-implement](sdlc-implement.md),
and adds the gates of the [AI-SDLC framework](https://github.com/ai-sdlc-framework/ai-sdlc)
(Apache-2.0): a definition-of-ready check before any work, open questions in the decision-rubric
format, three independent reviewers with one shared verdict, fix rounds driven by the reviewers'
findings, and an evidence record on the pull request. The weight of the change decides how much of
that applies: **lite** or **full**.

```
source ─ jira_issue/github_issue ─ intake ─ dor_check ─ dor_gate ─┬─ requirements ─ design ─ weight_proposal ─ design_review ─ weight ─┐
                                                                  └─ dor_message ─ dor_send_back  (not ready: nothing is built)         │
        build ◄──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
          ├─ lite:  lite_review_1 ─ lite_gate_1 ─ lite_fix ─ lite_review_2 ───────────────────────────────┐
          └─ full:  code/test/security_1 ─ gate_1 ─ fix_1 ─ code/test/security_2 ─ gate_2 ─ fix_2 ─ …_3 ──┴─ finalize ─ ship_gate ─┬─ release_approval ─ push_branch ─ open_pr ─ release ─ retro
                                                                                                                                  └─ send_back
```

## Lite or full

The `design` agent reports signals from the code (`touches_sensitive`, `has_migration`, `risk` with
`risk_reasons`, and the planned files). Rules, not the agent alone, propose the path
(`weight_proposal`): **full** when the risk is high, a sensitive area (authentication, payments,
secrets, schema, CI or governance configuration, a public contract) or a migration is touched, the plan
has more than `lite_max_files` files (5), or the design's confidence is below `lite_min_confidence`
(6). Otherwise **lite**. Both numbers are in the workflow's `config:`.

The proposal, its reasons and the signals are in the `design_review` approval, where the approver
can set `weight` to `lite` or `full` instead of `auto`. The final path, whether it was overridden and by
whom are in the evidence record.

| | Lite | Full |
|---|---|---|
| Definition of ready, requirements, design, design review, build, tests, release approval | yes | yes |
| Reviewers | one combined reviewer (code, tests, security) | code, test and security reviewers in parallel, each on a different model |
| Fix rounds after findings | 1 | 2 |

## What comes from AI-SDLC

Its Claude Code plugin has two skills (`ai-sdlc-governance`, `decision-rubric`) plus agents
(`developer`, `code-reviewer`, `test-reviewer`, `security-reviewer`, `refinement-reviewer`) and the
`/ai-sdlc execute` pipeline. Each was adapted into a skill of this package, with `LICENSE` and
`SOURCE.md` beside it:

| Skill here | From AI-SDLC | Used by |
|---|---|---|
| `definition-of-ready` | `refinement-reviewer`: seven gates, pass/fail, confidence, a question on a fail, dispatchability | `dor_check` |
| `decision-rubric` | `decision-rubric`: problem, research, 3-4 options, recommendation with counter-argument | requirements and design agents |
| `ai-sdlc-governance` | `ai-sdlc-governance`, the `developer` agent, `CLAUDE.md`: never merge, close or force-push; no scope creep; conventional commits; escalate | the engineer |
| `reviewer-verdict` | the reviewers' shared JSON envelope with `promptInjectionDetected` | all reviewers |
| `code-review`, `test-review`, `security-review` | `code-reviewer`, `test-reviewer`, `security-reviewer` | the reviewers |

The other four skills are the ones of `sdlc-implement` (adapted from Cole Medin's PIV loop, MIT), with
the decision-rubric, weight-signal and governance additions.

The pipeline's other parts map as follows. The definition-of-ready gate is `dor_gate`: it passes when all
seven gates pass with no low-confidence gate and the work can be built as code, and otherwise
Slack gets the questions and nothing is built. Verdict aggregation is `gate_N` and `finalize`: a round
is approved only when every reviewer approves, no finding is `critical` or `major`, and no reviewer
reported a prompt injection. The iteration loop is written out as `fix_N` nodes (the engine's loop
cannot run an agent): the engineer gets the previous diff and the reviewers' findings. After the last
round the change is **flagged, not dropped**: the pull request is a draft titled
`[needs-human-attention]`, and the release approval says so.

Not carried over: worktrees and tmux parallel sessions, rebasing and merging (nothing in Azhi merges or
closes anything), and DSSE attestations. The **evidence record** stands in for the attestation: the
`finalize` script hashes the diff and every file, and records the tests, the weight decision, each
reviewer's verdict and the design approver. It goes in the pull request body and the approval. It is a
digest of what was reviewed, not a signature, and it does not prove who wrote the code.

## Verified findings

Each review round is followed by a verifier on a different model family. A critical or major finding
sends the change back for a fix round only when the verifier confirmed it with at least
`config.min_confidence` (80 out of 100); the engineer is given only those. Refuted findings, or ones
confirmed below the bar, are dropped and listed in the evidence record. Findings the verifier could not
settle do not trigger a fix round, but they keep the change from counting as approved, so the pull
request opens as a draft marked `[needs-human-attention]`. Reviewers number their findings (`C1`, `T1`,
`S1`, `L1`) so each can be matched to its check. See [confidence.md](confidence.md).

## Nodes

| Node | What it does |
|---|---|
| `source`, `jira_issue`, `github_issue`, `intake` | As in [sdlc.md](sdlc.md) |
| `dor_check`, `dor_gate`, `dor_message`, `dor_send_back` | Seven definition-of-ready gates; a vague or non-code ticket goes back to Slack with its questions |
| `requirements`, `design` | Read-only checkout; open questions in the rubric format; `design` adds the weight signals |
| `weight_proposal`, `design_review`, `weight` | Rules propose lite or full; a person answers every open question and may override; the final path routes the reviews |
| `build` | Writable checkout; the worker runs the test command and returns failures to the agent (3 attempts) |
| `lite_review_1`, `lite_verify_1`, `lite_gate_1`, `lite_fix`, `lite_review_2`, `lite_verify_2` | The lite path |
| `code_N`, `test_N`, `security_N`, `verify_N`, `gate_N`, `fix_N` | The full path, rounds 1 to 3 |
| `*verify*` | A verifier (`finding-verifier@1`, `gpt-5.4`) in a fresh checkout tries to refute each critical and major finding and scores its confidence (`schemas/verification.json`) |
| `finalize` | Python script: the last round that ran, its aggregated verdict, the evidence record. Critical and major findings count only when confirmed at `config.min_confidence` (80); refuted ones are dropped and listed, unverifiable ones flag the change for a person |
| `ship_gate` | `ship` only when the tests passed and something changed; open findings do not block (they flag), a failing test run does |
| `release_approval`, `push_branch`, `open_pr`, `release`, `send_back`, `retro` | As in sdlc-implement, with the evidence in the approval, the pull request body and the retro; a flagged change opens a draft |

Run inputs are those of sdlc-implement: `source`, `ticket`, `repo` and an optional `base_branch`.

## Setup

```bash
azhi example install ai-sdlc --repo OWNER/REPO --set slack_channel=C0123ABCD \
  --set test_command="npm ci && npm run build && npm test && npm run lint"   # or Mission Control > Marketplace
azhi copilot login                                  # or Secrets > Sign in with GitHub Copilot
azhi secret set github-read-token                   # read-only Contents + Issues
azhi secret set github-write-token                  # Contents + Pull requests: read and write
azhi secret set jira-api-token                      # the run plan asks for it even for GitHub tickets
azhi run <version-id> --published -i source=github -i ticket=OWNER/REPO#1 -i repo=OWNER/REPO --wait
```

Agents cannot run commands, so AI-SDLC's pre-commit checklist (build, test, lint, format) is the
`test_command`: put every check you want enforced in it. It runs on the worker with no secrets, so use a
worker you would trust as a CI runner for the repository. The three full-path reviewers use
`claude-sonnet-5`, `gpt-5.4` and `claude-opus-5.5` so they do not share blind spots; change `name` in
`profiles/*-reviewer@1.yaml` to models your Copilot subscription offers. Try it on a throwaway
repository first: a successful run pushes a branch and opens a pull request. The `finalize` step needs
Python (uv) on a worker.

## Verified

`test/ai-sdlc.test.ts` compiles the package (every agent tainted, every write gated), checks the
routing and the CEL of the definition-of-ready gate, the weight rules and override, and the reviewer
verdict gate, and runs `finalize` over the lite and full paths: the last round that ran wins over skipped
ones, findings after the second fix round flag the change, a failing test run does not ship, an
override is recorded with its approver, and a prompt-injection report blocks approval. Not yet run
end to end with OpenCode and a live model, and not run against github.com; the node types are the ones
`test/sdlc-implement.test.ts` exercises end to end.
