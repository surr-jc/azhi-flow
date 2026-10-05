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
