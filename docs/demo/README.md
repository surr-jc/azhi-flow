# Azhi Flow demo video

`out/azhi-flow-demo.mp4` (about 3 minutes, 1080p) is recorded from the real web app, driven by a
script, against invented sample data. Nothing in it comes from a live server, and the numbers on
screen (spend, tokens, run counts) are sample data, not benchmarks.

| File | What it is |
|---|---|
| `mock.mjs` | The sample data: the pr-review workflow (same graph as `examples/pr-review`), runs, approvals, usage, tools, a finished run with ledger, context manifests and usage, and the editor check that rejects an ungated write. |
| `harness.mjs` | Serves `src/web/dist` and answers `/v1/*` from `mock.mjs`. |
| `record.mjs` | The script: scenes, captions, title cards, cursor, and the ffmpeg encode. Also writes `azhi-flow-demo.srt` and `narration.md` (the captions with timestamps, for dubbing or translation). |

## Regenerate

```sh
npm ci
npm run build:web
node docs/demo/record.mjs                 # all scenes, about 4 minutes
node docs/demo/record.mjs editor run      # only some scenes, to try a change
```

Needs Chromium for Playwright and `ffmpeg`. If Playwright is not a project dependency, point
`PLAYWRIGHT_PKG` at an installed copy and `CHROMIUM` at the browser binary.

## Scenes

1. **Intro**: the problems (agents die halfway, retries post twice, nobody knows the cost) and the workflow-first idea.
2. **Mission Control**: running, waiting, spend today, a pending approval.
3. **Workflow-first**: only the five agent steps call a model; fetch, route, report and post are plain code.
4. **Build the harness**: per-agent harness settings; add a tool from the catalog; the taint rule refuses an ungated write; a guard fixes it.
5. **Every run is evidence**: replay, action ledger, policy coverage, context manifest, cost per step.
6. **Human in the loop**: approving a waiting decision.
7. **Tokens and cost**: usage per day and workflow, spend limits, unknown never shown as zero.
8. **How Azhi saves tokens** and **what is unique** (cards), then the close.

The token card lists mechanisms that exist today (see `docs/positioning.md`), not measured savings.
