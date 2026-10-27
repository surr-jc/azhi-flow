# Runbook: AI-SDLC delivery for GitHub issue #27 using ChatGPT through OpenCode

## Objective

Run the AI-SDLC feature-delivery workflow for [issue #27](https://github.com/surr-jc/azhi-flow/issues/27), `Add global provider, harness, and model availability controls with impacted-workflow remediation`, using the OpenCode harness authenticated with a ChatGPT plan.

This runbook deliberately stops at human approvals. It does not authorize a workflow run, a branch push, or a pull request until the named approver accepts each applicable gate.

## Current preflight findings

| Check | Result | Action before run |
| --- | --- | --- |
| Issue | Open enhancement in `surr-jc/azhi-flow` | Use `source=github`, `ticket=surr-jc/azhi-flow#27`, and `repo=surr-jc/azhi-flow`. |
| AI-SDLC example | Installed prerequisites include repository access, Slack, GitHub read/write, and Copilot credentials; Jira token is currently absent | Jira is not needed for this GitHub ticket. Confirm all GitHub/Slack credentials remain valid. |
| Worker harness | Git, ripgrep, and OpenCode 1.18.34 are available on this Windows worker | Run the live workflow only after the ChatGPT sign-in and an explicit worker trust check. |
| Existing test command | `npm ci && npm test` | Update the AI-SDLC configuration to `npm ci && npm run typecheck && npm test` for this TypeScript/UI feature, subject to approval. |
| Working tree | `web/src/pages/Editor.tsx` is already modified | Do not touch, stage, or include that local change. Agents use fresh workflow checkouts. |

## Required package adaptation: ChatGPT/OpenCode

The shipped `ai-sdlc` profiles use `github-copilot` and several Copilot-only pinned models. `--provider openai-chatgpt` affects only profiles named `default`, so it cannot convert the full review path by itself.

Before publishing a run-ready version, create a new AI-SDLC package version whose OpenCode profiles use:

```yaml
model: {provider: openai-chatgpt, name: <approved-model>, credential: openai-chatgpt-auth}
```

Suggested initial model map (verify availability after sign-in before saving it):

| Role | Suggested model |
| --- | --- |
| Default-model roles: definition-of-ready, analyst, architect, engineer, lite reviewer | `default` (server setting `AZHI_CHATGPT_MODEL`) |
| Code reviewer | `gpt-6.1-sol` |
| Test reviewer | `gpt-5.6-terra` |
| Security reviewer | `gpt-6-astra` |
| Finding verifier | `gpt-5.6-sol` |

This preserves reviewer diversity within the available ChatGPT/OpenCode model catalog, but not the original cross-provider diversity. If any selected model is unavailable to the plan, replace it only with an available ChatGPT model and record that change in the package/version review.

The package configuration must also replace the declared `github-copilot-token` requirement with `openai-chatgpt-auth`, while retaining `github-read-token`, `github-write-token`, `slack-bot-token`, and the GitHub tool repository allow-list for `surr-jc/azhi-flow`.

## Execution sequence

1. **Safeguard local state.** Record `git status --short`; do not alter the existing `web/src/pages/Editor.tsx` change. Confirm the branch/commit that the workflow will use as its base.
2. **Validate the issue and package.** Re-read issue #27, confirm it is open, and prepare the ChatGPT-adapted package in a separate clean directory or as a new workflow version. Run local validation and a run plan. Resolve every missing grant, unsupported model, and taint/policy blocker before proceeding.
3. **Authenticate the harness.** Run `azhi chatgpt login`, complete the device-code sign-in in the browser, then run `azhi chatgpt check`. The sign-in is stored as `openai-chatgpt-auth`; it must be dedicated to Azhi and not shared with another OpenCode/Codex instance because refresh tokens rotate.
4. **Confirm runtime readiness.** Confirm the repository allow-list, GitHub read/write tokens, Slack credential/channel, worker availability, Python/uv for `finalize`, and the approved test command. The worker executes repository code after the agent edits it, with no secrets; use only a worker acceptable as a CI runner.
5. **Publish a reviewed version.** Publish the adapted package/version only after the plan identifies every agent as `openai-chatgpt` through `executor: opencode` and no Copilot-only named profile remains.
6. **Start the run.** Use the published version and inputs:

   ```powershell
   azhi run ai-sdlc --published `
     --provider openai-chatgpt `
     -i source=github `
     -i ticket=surr-jc/azhi-flow#27 `
     -i repo=surr-jc/azhi-flow `
     --wait
   ```

   If the published workflow has a different slug/version, substitute that reviewed identifier. Do not add `base_branch` unless the approver specifies one; its absence uses the workflow/repository default.
7. **Definition-of-ready gate.** If the workflow asks questions or reports a low-confidence readiness gate, send it back for clarification. Do not build until readiness passes.
8. **Design/weight approval.** Review requirements, design, changed-file plan, risk signals, and proposed lite/full path. Select `lite` only if the acceptance criteria, risk, and change size warrant it; otherwise select `full`. Issue #27 changes global availability controls and workflow remediation, so the default recommendation is **full** unless the design proves a narrowly scoped, low-risk implementation.
9. **Build and verification.** Let the build agent edit its isolated checkout and run the approved checks. Review failure evidence before allowing any retry/change in scope.
10. **Review/fix cycles.** On the full path, evaluate code, test, and security reviewers plus independent finding verification. Only confirmed critical/major findings feed a fix round; unresolved findings keep the change flagged for human attention.
11. **Release approval.** Inspect the final diff, evidence record, test result, weight decision, reviewer verdicts, and branch target. Approve only if the implementation meets all issue acceptance criteria and no disallowed local change is included.
12. **External writes.** After release approval, Azhi may push one `azhi/` branch and open one pull request. It never merges or closes the pull request. Verify the PR body includes the evidence record and is a draft when findings remain unresolved.
13. **Closeout.** Inspect the final run/action ledger, capture the run and PR URLs, confirm Slack notification delivery, and preserve the evidence record with the issue.

## Approval checkpoints

| Checkpoint | Human decision required | Proceed only when |
| --- | --- | --- |
| A | Approve this runbook and the ChatGPT-only adaptation | Model map, test command, repository target, and reduced cross-provider diversity are accepted. |
| B | Approve ChatGPT device login | The browser/device-code sign-in is completed by the account owner. |
| C | Approve design and proposed workflow weight | Scope, architecture, migration implications, and lite/full route are acceptable. |
| D | Approve release | Final diff, evidence, tests, and PR target are acceptable before push/PR creation. |

## Rollback and stop conditions

- Cancel the run if the issue is no longer open, a model is unavailable, a credential check fails, a plan/policy blocker appears, or the workflow attempts to use a non-ChatGPT model/provider.
- At readiness/design/release gates, select the workflow's send-back path rather than continuing when scope or evidence is insufficient.
- If a branch/PR was already created, do not delete or force-push it through this runbook; close or amend it only under a separate explicit instruction.

## Proposed approval request

Approve checkpoints A and B to let the operator: (1) create and validate the ChatGPT-adapted AI-SDLC package version, and (2) begin the ChatGPT device-code login. The workflow itself will remain unstarted until a subsequent explicit trigger approval.
