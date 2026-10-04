# Alpha demo

The alpha ends on six pass/fail checks, live, on a fresh install (spec section 13).
`npm run demo` runs them and prints the evidence for each.

```bash
# PostgreSQL and Temporal reachable (for example from deploy/install.sh or the dev stack)
export AZHI_DEMO_DATABASE_URL=postgres://azhi:<password>@localhost:5432/azhi   # admin connection
export AZHI_TEMPORAL_ADDRESS=localhost:7233
export ANTHROPIC_API_KEY=sk-ant-... AZHI_ANTHROPIC_MODEL=<model id>         # optional: real model

npm run demo                 # checks 2 to 6
npm run demo -- --install    # also check 1: runs deploy/install.sh on this host and times it
```

The demo creates its own database and starts the server, the gateway and a worker as separate
`azhi` processes, so it can kill the gateway in the middle of a Slack post. Slack is the bundled
fake. Without `ANTHROPIC_API_KEY` the analyst talks to a scripted Anthropic-compatible endpoint and
the demo says so. Logs and results go to a temp directory printed at the end.

## Narration, check by check

1. **Install.** `deploy/install.sh` on a clean host; point at the total time it prints and at
   `azhi doctor` with one worker online.
2. **Plan.** `azhi plan examples/quality-report`: every requirement has a mark, every action has a
   coverage level, and the taint path `analyse → report → post` is gated by the CEL guard. Delete
   the `guard:` line and plan again: `tainted_write_ungated`.
3. **Scheduled run.** Nobody is attached. When the message arrives, show the numbered citations
   and the three as-of lines, then `azhi open <run>` for the page.
4. **Crash.** The gateway dies right after Slack accepted the post. A fresh gateway finds the
   message by its dedupe key instead of posting again; show the ledger line.
5. **Trust.** A second author's package: the `self` worker refuses it in the plan, and the run is
   never created.
6. **Comparison.** One command, 30 fixtures, both executors. The table says which numbers are
   estimated and that OpenCode's usage is incomplete; the ambient-tools section explains why its
   control is `harness`, not `enforced`.
