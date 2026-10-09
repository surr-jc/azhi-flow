// Mock Azhi Flow API for the demo video. Everything here is invented sample data; nothing talks to a
// real server. The pr-review graph mirrors examples/pr-review/workflow.yaml.
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min) => new Date(NOW + min * 60_000).toISOString();

const step = (id, type, depends_on = [], rest = {}) => ({ id, type, description: rest.description ?? id, ...(depends_on.length ? { depends_on } : {}), ...rest });
const reviewer = (id, description) => step(id, 'agent', ['pr'], {
  description, executor: 'opencode', profile: `${id}-reviewer@1`, output_schema: 'schemas/findings.json', timeout: '15m', budget: { max_tool_calls: 10 },
  workspace: { repo: { ref: 'inputs.repo' }, credential: 'github-read-token' }, input: { map: "{'pr': nodes.pr.output}" },
});

/** The pr-review workflow as the editor first opens it: the PR comment step is not added yet. */
export const baseDefinition = {
  id: 'pr-review', name: 'Pull request review (OpenCode)', schema_version: '2.0',
  description: 'Correctness, security, tests and quality reviewers in isolated checkouts, a summarizer, a PR comment and a Slack notification.',
  trigger: { manual: true }, config: { channel: 'C0QUALITY' },
  inputs: { type: 'object', properties: { repo: { type: 'string', title: 'Repository' }, pr: { type: 'integer', title: 'Pull request number' }, post: { type: 'boolean', default: true, title: 'Post the review' } }, required: ['repo', 'pr'] },
  nodes: [
    step('pr', 'tool', [], { description: 'Read the pull request and its changed files from GitHub.', tool: 'github.get-pull-request@1', arguments: { repo: { ref: 'inputs.repo' }, number: { ref: 'inputs.pr' } } }),
    reviewer('correctness', 'Look for bugs the change introduces.'),
    reviewer('security', 'Look for security problems in the change.'),
    reviewer('tests', "Check the change's tests and style."),
    reviewer('quality', "Check the change's code quality and maintainability."),
    step('summarize', 'agent', ['correctness', 'security', 'tests', 'quality'], { description: 'Merge the findings into one review with a verdict.', executor: 'opencode', profile: 'review-summarizer@1', output_schema: 'schemas/review.json', timeout: '10m', budget: { max_tool_calls: 2 } }),
    step('report', 'report', ['summarize'], { description: 'The review as a run artifact.', template: 'templates/review.md' }),
    step('should_post', 'condition', ['summarize'], { description: 'Post unless this is a dry run.', expression: "has(inputs.post) && !inputs.post ? 'skip' : 'post'", routes: { post: ['post'], skip: [] }, default: 'post' }),
  ],
};
const guarded = { description: 'Post the review as a comment on the pull request.', tool: 'github.comment-on-pr@1', arguments: { repo: { ref: 'inputs.repo' }, number: { ref: 'inputs.pr' }, body: { ref: 'nodes.summarize.output.body' } }, guard: 'args.repo == inputs.repo && args.number == inputs.pr' };
export const fullDefinition = {
  ...baseDefinition,
  nodes: [...baseDefinition.nodes,
    step('post', 'tool', ['should_post'], guarded),
    step('notify', 'notify', ['post'], { description: 'Slack message with the verdict.', channel: 'slack', destination: { ref: 'config.channel' }, message: { ref: 'nodes.summarize.output.body' }, guard: 'args.channel == config.channel' })],
};

const graph = (def) => def.nodes.map((n) => {
  const deps = new Set(n.depends_on ?? []);
  const route = def.nodes.filter((c) => c.type === 'condition').flatMap((c) => Object.entries(c.routes ?? {}).filter(([, m]) => m.includes(n.id)).map(([r]) => ({ condition: c.id, route: r })))[0];
  return { id: n.id, type: n.type, deps: [...deps], ...(route ? { route } : {}), def: n };
});
export const planNodes = graph(fullDefinition);

const cov = (action, enforcement, detail) => ({ action, enforcement, detail });
const planFor = (nodes = planNodes) => ({
  workflow: 'pr-review', version: 4, package_hash: 'sha256:9c1e…ab42', signer: { publisher: 'acme-platform', verified: true }, ok: true, blockers: [], missing_grants: [],
  nodes: nodes.map((n) => ({
    id: n.id, type: n.type,
    requirements: n.type === 'agent' ? [{ name: 'executor opencode', mark: 'native', detail: 'OpenCode is installed on worker w-linux-1' }, { name: 'read-only checkout', mark: 'native', detail: 'Isolated git and HOME, deleted after the step' }] : [],
    coverage: n.type === 'agent' ? [cov('write files', 'harness', 'OpenCode edit tool is off'), cov('call tools', 'enforced', 'Only the gateway tools in the profile')] : n.id === 'post' ? [cov('github.comment-on-pr', 'enforced', 'Guard pins it to the reviewed PR')] : [],
    ...(n.type === 'agent' && n.id !== 'summarize' ? { tainted: 'reads untrusted code from the PR checkout' } : {}),
  })),
});

const run = (id, state, workflow, version, minutesAgo, took = 6, extra = {}) => ({ id, state, flags: {}, trigger: 'manual', test: false, inputs: { repo: 'acme/payments', pr: 482 }, created_at: ago(minutesAgo), ended_at: state === 'running' || state === 'waiting' ? null : ago(minutesAgo - took), workflow, version, workflow_version: version, ...extra });
export const runs = [
  run('run_8f21c4e7', 'running', 'pr-review', 4, 2),
  run('run_71ab09d2', 'waiting', 'sdlc-implement', 2, 41, 0, { inputs: { repo: 'acme/payments', ticket: 'PAY-1182' } }),
  run('run_5d03ee19', 'succeeded', 'pr-review', 4, 55, 7),
  run('run_3c7b2a60', 'succeeded', 'quality-report', 9, 190, 3, { trigger: 'schedule', inputs: {} }),
  run('run_2e91f0b4', 'failed', 'issue-investigation', 1, 260, 4, { inputs: { repo: 'acme/ledger', issue: 931 } }),
  run('run_1a44d8c3', 'succeeded', 'pr-review', 4, 330, 6),
  run('run_0b9e5571', 'succeeded', 'pr-review', 3, 1500, 8),
];
export const finishedRun = run('run_5d03ee19', 'succeeded', 'pr-review', 4, 55, 7);

export const summaries = [
  { slug: 'pr-review', latest: { id: 'ver_pr4', version: 4, draft: false, signed: true, created_at: ago(2000), name: 'Pull request review (OpenCode)', description: baseDefinition.description }, published: { id: 'ver_pr4', version: 4, signed: true, created_at: ago(2000) }, schedule: null, last_run: { id: 'run_8f21c4e7', state: 'running', created_at: ago(2) } },
  { slug: 'quality-report', latest: { id: 'ver_qr9', version: 9, draft: false, signed: true, created_at: ago(9000), name: 'Weekly quality report', description: 'Metrics from CI, analysed by a model, posted to Slack with numbered citations.' }, published: { id: 'ver_qr9', version: 9, signed: true, created_at: ago(9000) }, schedule: { id: 's1', cron: '0 8 * * 1', timezone: 'Europe/Berlin', enabled: true, next_occurrence_at: ahead(2800) }, last_run: { id: 'run_3c7b2a60', state: 'succeeded', created_at: ago(190) } },
  { slug: 'sdlc-implement', latest: { id: 'ver_sd2', version: 2, draft: false, signed: true, created_at: ago(5000), name: 'Feature delivery to a pull request', description: 'Jira ticket to requirements, design, build, tests and a reviewed pull request.' }, published: { id: 'ver_sd2', version: 2, signed: true, created_at: ago(5000) }, schedule: null, last_run: { id: 'run_71ab09d2', state: 'waiting', created_at: ago(41) } },
  { slug: 'issue-investigation', latest: { id: 'ver_ii1', version: 1, draft: false, signed: true, created_at: ago(7000), name: 'Issue root-cause investigation', description: 'An investigator agent walks repo history and writes an RCA.' }, published: { id: 'ver_ii1', version: 1, signed: true, created_at: ago(7000) }, schedule: null, last_run: { id: 'run_2e91f0b4', state: 'failed', created_at: ago(260) } },
];

const spend = (amount, turns, i, o) => ({ turns, unpriced_turns: 0, amount, currency: 'USD', complete: true, input_tokens: i, output_tokens: o });
export const overview = {
  open: { running: 1, queued: 0, waiting: 1 }, last_24h: { succeeded: 14, failed: 1, delivery_failed: 0 },
  workers: { total: 3, online: 3 }, approvals: { pending: 1, mine: 1 },
  spend: { today: spend(3.42, 61, 412_000, 38_000), week: spend(21.8, 402, 2_940_000, 251_000) },
  schedules: [{ id: 's1', workflow: 'quality-report', cron: '0 8 * * 1', timezone: 'Europe/Berlin', inputs: {}, enabled: true, next_occurrence_at: ahead(2800), last_run: { id: 'run_3c7b2a60', state: 'succeeded', created_at: ago(190) } }],
};
export const alerts = [
  { key: 'a1', level: 'critical', kind: 'run_failed', message: 'issue-investigation failed 4 hours ago: the repo-history MCP server timed out.', run_id: 'run_2e91f0b4', workflow: 'issue-investigation', at: ago(260) },
  { key: 'a2', level: 'warning', kind: 'budget', message: 'pr-review has used 82% of its daily limit ($5.00).', workflow: 'pr-review', at: ago(30) },
];
export const approvals = [{
  run_id: 'run_71ab09d2', node_id: 'approve_diff', workflow: 'sdlc-implement', version: 2, run_state: 'waiting', test: false, requested_at: ago(38),
  request: { message: 'Approve the diff for PAY-1182 (idempotency key on refunds)? Tests passed on the build checkout: 41 of 41.', payload: { files_changed: 6, additions: 188, deletions: 23, tests: '41 passed' }, role: 'operator', expires_at: ahead(1300), on_expiry: 'reject' },
  role: 'operator', decision_schema: null, expires_at: ahead(1300), can_decide: true,
}];

export const usage = {
  days: 14,
  by_day: Array.from({ length: 14 }, (_, i) => ({ day: new Date(NOW - (13 - i) * 86400_000).toISOString(), turns: 20 + ((i * 7) % 29), unpriced: 0, cost: [1.2, 1.8, 2.4, 2.1, 0.9, 0.6, 2.9, 3.3, 3.1, 2.7, 3.8, 2.2, 1.1, 3.4][i], input_tokens: 150_000 + i * 18_000, output_tokens: 14_000 + i * 1_200, credits: null })),
  by_workflow: [
    { workflow: 'pr-review', runs: 96, turns: 612, unpriced: 0, cost: 18.4, input_tokens: 2_310_000, output_tokens: 190_000, credits: null },
    { workflow: 'sdlc-implement', runs: 7, turns: 148, unpriced: 0, cost: 9.9, input_tokens: 1_020_000, output_tokens: 96_000, credits: null },
    { workflow: 'quality-report', runs: 4, turns: 8, unpriced: 0, cost: 0.3, input_tokens: 24_000, output_tokens: 6_200, credits: null },
    { workflow: 'issue-investigation', runs: 5, turns: 61, unpriced: 0, cost: 2.6, input_tokens: 380_000, output_tokens: 31_000, credits: null },
  ],
};
export const budgets = [{ id: 'b1', workflow: 'pr-review', period: 'day', limit: 5, spent: 4.1, created_at: ago(9000) }, { id: 'b2', workflow: null, period: 'month', limit: 150, spent: 61.2, created_at: ago(9000) }];

export const tools = [
  { id: 'github.get-pull-request', version: 1, description: 'Read a pull request and its changed files', effect: 'read' },
  { id: 'github.comment-on-pr', version: 1, description: 'Post a comment on a pull request', effect: 'write' },
  { id: 'github.get-issue', version: 1, description: 'Read a GitHub issue', effect: 'read' },
  { id: 'github.create-pull-request', version: 1, description: 'Open a pull request from an azhi/ branch', effect: 'write' },
  { id: 'jira.get-issue', version: 1, description: 'Read a Jira ticket', effect: 'read' },
  { id: 'ci.list-runs', version: 1, description: 'List recent CI runs', effect: 'read' },
  { id: 'incidents.list-open', version: 1, description: 'List open incidents', effect: 'read' },
];

// ---- a finished pr-review run -------------------------------------------------------------
const att = (node_id, startedMin, secs, output, worker = 'w-linux-1') => ({ node_id, state: 'succeeded', attempt: 1, worker_id: worker, started_at: ago(startedMin), ended_at: new Date(NOW - startedMin * 60_000 + secs * 1000).toISOString(), output });
const m = (node_id, tokens, items, tainted = false) => ({ node_id, attempt: 1, turn: 1, total_tokens: tokens, token_source: 'provider', tainted, items });
const item = (kind, source, reason, tokens, hash) => ({ kind, source, reason, tokens, content_hash: `sha256:${hash}` });
const rec = (node_id, cost, input_tokens, output_tokens) => ({ node_id, cost, input_tokens, output_tokens, cache_read_tokens: Math.round(input_tokens * 0.4), cache_write_tokens: 0, model: 'claude-sonnet', turn: 1, attempt: 1 });
export const runDetail = {
  run: { ...finishedRun, workflow_version_id: 'ver_pr4', snapshot: {}, error: null },
  attempts: [
    att('pr', 54, 2, { number: 482, title: 'Make refund idempotent', mergeable_state: 'clean' }),
    att('correctness', 53, 71, { findings: [{ title: 'Retry reuses stale idempotency key', severity: 'medium' }] }),
    att('security', 53, 64, { findings: [] }),
    att('tests', 53, 58, { findings: [{ title: 'No test for duplicate refund request', severity: 'low' }] }),
    att('quality', 53, 66, { findings: [] }),
    att('summarize', 51, 22, { verdict: 'comment', body: 'Two small findings; no blockers.' }),
    att('report', 50, 1, 'ok'), att('should_post', 50, 0, 'post'), att('post', 50, 2, { comment_id: 99102 }), att('notify', 50, 1, { ts: '1728472110.0021' }),
  ],
  approvals: [],
  actions: [
    { id: 'act_01', node_id: 'post', tool: 'github.comment-on-pr@1', effect: 'write', state: 'confirmed', transitions: [{ state: 'intended', fence: 1 }, { state: 'sent', fence: 1 }, { state: 'confirmed', fence: 1 }], receipt: { comment_id: 99102 } },
    { id: 'act_02', node_id: 'notify', tool: 'slack.post-message@1', effect: 'write', state: 'confirmed', transitions: [{ state: 'intended', fence: 1 }, { state: 'sent', fence: 1 }, { state: 'confirmed', fence: 1 }], receipt: { ts: '1728472110.0021' } },
  ],
  context_manifests: [
    m('correctness', 18400, [item('instruction', 'profile correctness-reviewer@1', 'agent prompt and skills', 2100, 'a91c0e7b3d11'), item('data', 'github.get-pull-request@1', 'projected: title, files, patch', 3900, '5be0f2210a44'), item('workspace', 'checkout refs/pull/482/head', 'read-only files the agent opened', 12400, 'd7742aa9f1c0')], true),
    m('security', 16900, [item('instruction', 'profile security-reviewer@1', 'agent prompt and skills', 2400, 'c3d0aa91e2f7'), item('data', 'github.get-pull-request@1', 'projected: title, files, patch', 3900, '5be0f2210a44')], true),
    m('summarize', 5200, [item('instruction', 'profile review-summarizer@1', 'agent prompt', 900, '0c5e7f9b8a31'), item('data', 'nodes.correctness.output', 'structured findings only', 640, '3fa21b77c5d9')], false),
  ],
  usage: { turns: 9, completeness_pct: 100, cost: { amount: 0.31, currency: 'USD' }, input_tokens: 61_300, output_tokens: 5_800, records: [rec('correctness', 0.08, 17_900, 1_100), rec('security', 0.07, 16_400, 900), rec('tests', 0.07, 15_100, 1_000), rec('quality', 0.07, 14_900, 1_300), rec('summarize', 0.02, 5_000, 600)] },
  plan: planFor(),
};
const ev = (seq, minAgo, kind, node_id = null, data = {}) => ({ seq, at: ago(minAgo), kind, node_id, data });
export const events = [
  ev(1, 54, 'run.started'), ev(2, 54, 'node.running', 'pr'), ev(3, 54, 'node.succeeded', 'pr'),
  ...['correctness', 'security', 'tests', 'quality'].flatMap((n, i) => [ev(4 + i * 2, 53, 'node.running', n), ev(5 + i * 2, 52 - (i % 2) * 0.1, 'node.succeeded', n)]),
  ev(12, 51, 'node.running', 'summarize'), ev(13, 50.5, 'node.succeeded', 'summarize'),
  ev(14, 50, 'node.running', 'report'), ev(15, 50, 'node.succeeded', 'report'),
  ev(16, 50, 'node.succeeded', 'should_post', null, { route: 'post' }), ev(17, 50, 'node.running', 'post'), ev(18, 49.9, 'node.succeeded', 'post'),
  ev(19, 49.9, 'node.running', 'notify'), ev(20, 49.8, 'node.succeeded', 'notify'), ev(21, 49.8, 'run.succeeded'),
].map((e) => (e.kind === 'node.succeeded' && e.node_id === 'should_post' ? { ...e, node_id: 'should_post', data: { route: 'post' } } : e));

// ---- editor checks: a write after an agent that read untrusted code needs a guard ------------
export function check(body) {
  const nodes = body?.definition?.nodes ?? [];
  const diagnostics = [];
  for (const n of nodes) {
    if (n.type === 'tool' && /comment-on-pr|create-pull-request/.test(n.tool ?? '') && !n.guard) {
      diagnostics.push({ severity: 'error', code: 'taint.ungated_write', node: n.id, message: `${n.id} writes after agents that read untrusted pull request code. Add a guard that pins the write to the reviewed pull request.` });
    }
  }
  const def = body?.definition ?? baseDefinition;
  return { ok: diagnostics.length === 0, diagnostics, yaml: `id: ${def.id}\nnodes: ${nodes.length} steps\n`, plan: planFor(graph({ nodes })) };
}
export { planFor, graph };
