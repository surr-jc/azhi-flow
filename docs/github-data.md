# Real data for the quality report: GitHub Actions and Issues

The flagship workflow reads three tools: `ci.list-runs@1`, `tests.list-flaky@1` and
`incidents.list-open@1`. The shipped config (`azhi.config.yaml`) registers them with fixture data.
`examples/quality-report/azhi.config.github.yaml` registers the same ids with GitHub transports, so
the workflow is unchanged and only the data source differs.

| Tool | Reads | Output |
|---|---|---|
| `ci.list-runs` (`github.ci-runs`) | Completed Actions runs since `since`, up to 300 per repository | `id` (`owner/repo#run`), `status` (success, failure, cancelled), `branch`, `started_at`, `finished_at`, `failed_tests` (names of failed jobs for the first 20 failed runs; the rest are empty) |
| `tests.list-flaky` (`github.flaky-tests`) | Open issues labelled `flaky-test` (pull requests are skipped) | `test` (issue title), `failures` (comments + 1), `quarantined` (issue has the `quarantined` label) |
| `incidents.list-open` (`github.incidents`) | Open issues labelled `incident` | `id`, `title`, `severity` (from a `sev1` to `sev5` label, else `unknown`), `opened_at` |

## Set up

1. Edit `repos` in the config (`OWNER/REPO`, several allowed). For GitHub Enterprise Server add
   `api_url: https://<host>/api/v3` to each tool's `config`.
2. Create a token that can read Actions and Issues on those repositories (a fine-grained token with
   read-only "Actions" and "Issues" access is enough), then
   `azhi secret set github-token --value <token>`.
3. `azhi apply examples/quality-report/azhi.config.github.yaml`, then run the workflow.

Notes: the tools are read-only, go through the gateway like every other tool (egress rules, the
action ledger and as-of times apply), and the token is a workspace secret that never enters a
package or run state. `team` is accepted but not used to filter; put one team's repositories in the
config, or register one tool revision per team. "Failed tests" are failed job names, not individual
test cases, because Actions does not expose test results without parsing logs or artifacts.

## Falling back to the GitHub CLI

Every GitHub tool calls the REST API first. A tool registration can add `cli_fallback` to its `config` so a
failed call is tried once more through `gh api` on the server's machine:

| Value | `gh api` is tried after | Acts as |
|---|---|---|
| `off` (default) | nothing | n/a |
| `network` | a refused connection or a certificate failure (a read also after a reset) | the same token; only gh's network stack differs (it uses the Windows certificate store and system proxy, Node does not) |
| `login` | the above, and a 401 or an SSO 403, or no token being set | gh's own login in those last cases, which may be a broader identity than the token |

A write is never sent twice: a reset or timeout after it may have been sent is left to the action ledger's
lookup, and a 404, a rate limit or a 5xx is final. The egress rules are checked before either path, and the
server setting `AZHI_GH_FALLBACK=off` turns the fallback off everywhere. When gh is missing or signed out, the
original error is reported with the reason appended. A fallback call writes one `azhi: GitHub ... went through the
GitHub CLI` line to the server's stderr.
