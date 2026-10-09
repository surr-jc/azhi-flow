# Getting results you can trust: gap review of the example workflows

Date: 9 October 2026. Scope: `examples/pr-review`, `examples/issue-investigation`, `examples/ai-sdlc`
(`sdlc` and `sdlc-implement` are earlier versions of the same flow).

Goal: results a person can act on with at least 80% confidence, on the models a Copilot
subscription offers.

**What this document does not claim.** No benchmark has been run. The 80% is a bar the workflows now
*enforce per finding* (a verifier must reach 80 out of 100 on it), not a measured precision. Measuring
it is the first remaining gap below.

## Gaps found

| # | Gap | Where | Effect |
|---|---|---|---|
| 1 | Every finding was one agent's single pass. Nothing tried to refute it, and the summarizer has no checkout, so it could only merge and rank. | `pr-review`, `issue-investigation` | False positives reached the PR comment; wrong root causes reached the issue |
| 2 | Confidence was self-reported by the agent that wrote the answer. | `issue-investigation` (`assessment.confidence`) | "high" meant "I believe myself" |
| 3 | The four reviewers all ran `default` (one model), so they shared blind spots. | `pr-review`, most `ai-sdlc` profiles | Correlated misses and correlated mistakes |
| 4 | Findings needed no reproducible scenario or stable id, so they could not be checked one by one. | `pr-review` schema | No way to join a finding to a verdict |
| 5 | The bug-hunting method was a short checklist, with no coverage audit. | `pr-review` correctness and security | Files skipped silently |
| 6 | The investigator's method had no "one hypothesis at a time" or "claim only what you read" rule. | `issue-investigation` | Plausible chains with an unchecked link |
| 7 | `ai-sdlc` reviewers (code, test, security) are not verified before their findings send the change into a fix round. | `ai-sdlc` | A wrong finding costs a build round (**fixed**, below) |
| 8 | No labelled evaluation, so no workflow change can be shown to help. | `bench/` covers executors only | Quality changes are judged by feel |

Not a gap: `max_tool_calls: 10`. It counts calls through the Azhi gateway bridge (for example
`submit_output`), not OpenCode's own read and grep, so it does not limit how much code an agent reads.
The limit on reading is the node `timeout`.

## What changed

| Gap | Change |
|---|---|
| 1, 2 | `pr-review`: new `verify` (refutes each finding, scores 0 to 100) and `triage` (plain script: keep confirmed at 80+, set aside unverifiable, drop refuted). `issue-investigation`: new `challenge` (refutes the analysis) and `calibrate` (high only when both agree); a refuted analysis is never posted |
| 3 | Security reviewer on `claude-opus-5.5`; the verifier and the challenger on `gpt-5.4`, a different family from the Sonnet reviewers. Change the names in the profiles if your plan lacks them |
| 4 | Findings need an `id` and a `scenario` (`schemas/findings.json`) |
| 5 | `find-bugs` skill on the correctness and security reviewers |
| 6 | `systematic-debugging` and `evidence-before-claims` on the investigator |
| 7 | `ai-sdlc`: a verifier after every review round (5 nodes); only confirmed critical and major findings trigger a fix round or count in `finalize`. Unverifiable ones flag the change for a person |

Cost: one extra agent step per review or investigation (plus a second checkout), and Opus for the
security reviewer. In return, the verifier runs once for all findings, not once per finding.

## Skills chosen, and why

| Skill | Source | License | Used for |
|---|---|---|---|
| `find-bugs` | [getsentry/skills](https://github.com/getsentry/skills) | Apache-2.0 | Attack-surface mapping, per-file checklist, a pre-conclusion coverage audit |
| `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) | MIT | Root cause before fix; one hypothesis at a time |
| `evidence-before-claims` (from `verification-before-completion`) | [obra/superpowers](https://github.com/obra/superpowers) | MIT | Every claim backed by a line read in this run; confidence follows the weakest link |
| `finding-verification`, `root-cause-challenge` | Written for Azhi | Apache-2.0 | The refutation step |

The verification stage follows a design published in Anthropic's `code-review` plugin for Claude Code
([anthropics/claude-code](https://github.com/anthropics/claude-code), `plugins/code-review`): parallel
finders, then a separate validation pass per issue, and only survivors reported. That repository is
not under an open-source license that allows copying, so only the idea was used; no text was copied.

Considered and not used:

- Trail of Bits `fp-check`, `differential-review`, `static-analysis`
  ([trailofbits/skills](https://github.com/trailofbits/skills)): strong for security work, but
  licensed CC-BY-SA-4.0, whose share-alike terms would apply to this package's skills. Worth adding if
  that is acceptable to you, or by running Semgrep or CodeQL as a script step (gap 8 below).
- Sentry `code-review` and `security-review`: framework-specific (Django, React) or derived from
  CC-BY-SA material.
- Superpowers `requesting-code-review`, `subagent-driven-development`: orchestration that Azhi's
  workflow graph already does.

## Remaining gaps

1. **Measure it (gap 8).** Build a labelled set: 30 to 50 PRs with known defects and clean PRs, and
   issues with known root causes, run the workflows, and report precision and recall, with the
   verifier on and off. Until then, 80% is a threshold, not a result. `bench/compare.ts` is the place
   to extend.
2. **Ground findings in tools, not only reading.** Run the project's tests, type checker and a
   static analyzer (Semgrep, CodeQL) on the PR checkout as a script step and give the output to the
   reviewers and the verifier. `sdlc-implement` and `ai-sdlc` already run tests on the build
   checkout (`workspace.test`); `pr-review` does not.
3. **Reproduction for issues.** The investigator is read-only, so a bug is traced, not reproduced.
   A sandbox step that runs the reporter's steps would turn "medium" into "high" for many issues.
4. **Model names.** `gpt-5.4` and `claude-opus-5.5` are Copilot model names used elsewhere in this repo;
   if a plan does not include one, the step fails at start. Set the profile to `default` to fall back to one model
   (you then lose the independence of the second opinion).
