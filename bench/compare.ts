/**
 * Executor comparison: `npm run compare` plays the 30 fixtures through the platform model agent
 * and the OpenCode adapter against one scripted Anthropic-compatible endpoint, then writes a
 * Markdown report and the raw JSON. Needs Postgres and Temporal (as the integration tests do)
 * and the pinned `opencode` binary from devDependencies.
 *
 *   npm run compare -- [--out docs/executor-comparison.md] [--only direct,tool]
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { canonicalJson } from '../src/lib/hash.js';
import { startFakeAnthropic, type FakeStep } from '../src/testing/fake-anthropic.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';
import { opencodeBinary } from '../src/worker/capabilities.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun } from '../test/helpers/harness.js';
import { FIXTURES, type Fixture } from './fixtures.js';

const MODEL = 'comparison-model';
const EXECUTORS = ['agent', 'agent-openai', 'opencode'] as const;
type Executor = (typeof EXECUTORS)[number];

interface Result {
  fixture: string;
  kind: string;
  executor: Executor;
  pass: boolean;
  state: string;
  error_class: string | null;
  latency_ms: number;
  model_requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  usage_complete: boolean;
  non_gateway_tools: string[];
  note?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function packageFor(executor: Executor): string {
  const dir = mkdtempSync(join(tmpdir(), `azhi-cmp-${executor}-`));
  cpSync('test/fixtures/agent', dir, { recursive: true });
  writeFileSync(
    join(dir, 'profiles/analyst@1.yaml'),
    `model: {provider: ${executor === 'agent-openai' ? 'openai' : 'anthropic'}, name: default}\ninstructions: Explain the CI runs in one sentence.\npricing: {currency: USD, input_per_mtok: 3, output_per_mtok: 15, revision: comparison-2026-10}\n`,
  );
  if (executor === 'opencode') {
    const wf = join(dir, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('    profile: analyst@1\n', '    profile: analyst@1\n    executor: opencode\n'));
  }
  return dir;
}

async function main() {
  if (!(await temporalAvailable())) throw new Error('Temporal is not reachable; start the dev stack first (see README).');
  const withOpenCode = Boolean(opencodeBinary());
  if (!withOpenCode) console.warn('opencode binary not found: only the model agent will run.');
  const only = arg('only')?.split(',');
  const fixtures = FIXTURES.filter((f) => !only || only.some((o) => f.id.startsWith(o)));

  let script: FakeStep[] = [];
  const fake = await startFakeAnthropic({ script: () => script });
  const fakeOpenAI = await startFakeOpenAI({ script: () => script });
  const h = await startHarness({ settings: { anthropicApiUrl: fake.url, anthropicModel: MODEL, openaiApiUrl: fakeOpenAI.url, openaiModel: MODEL } });
  const results: Result[] = [];
  try {
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    await h.api.put('/v1/secrets/anthropic-api-key', { value: 'sk-comparison' });
    await h.api.put('/v1/secrets/openai-api-key', { value: 'sk-comparison' });
    const versions: Partial<Record<Executor, string>> = {};
    for (const e of EXECUTORS) if (e === 'agent' || withOpenCode) versions[e] = (await uploadDir(h.api, packageFor(e))).version.id;

    for (const f of fixtures) {
      for (const e of EXECUTORS) {
        if (!versions[e]) continue;
        script = f.script;
        const r = await runOne(h, e === 'agent-openai' ? fakeOpenAI : fake, versions[e]!, f, e);
        results.push(r);
        console.log(`${r.pass ? 'pass' : 'FAIL'}  ${e.padEnd(12)} ${f.id.padEnd(12)} ${r.state}${r.error_class ? ` (${r.error_class})` : ''} ${r.latency_ms} ms`);
      }
    }
  } finally {
    await h.stop();
    await fake.close();
    await fakeOpenAI.close();
  }

  const out = arg('out') ?? 'docs/executor-comparison.md';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(out, report(results, fixtures.length));
  console.log(`\nwrote ${out}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

async function runOne(h: Awaited<ReturnType<typeof startHarness>>, fake: { requests: Array<{ model: string; tools: string[] }> }, version: string, f: Fixture, e: Executor): Promise<Result> {
  const before = fake.requests.length;
  const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: {} });
  const d = await waitForRun(h.api, run_id, 180_000);
  const att = d.attempts.filter((a: any) => a.node_id === 'explain');
  const first = att[0];
  const last = att.at(-1);
  const latency = first && last?.ended_at ? new Date(last.ended_at).getTime() - new Date(first.started_at).getTime() : NaN;
  const calls = fake.requests.slice(before).filter((r) => r.model === MODEL);
  const offered = new Set(calls.flatMap((c) => c.tools));
  // Gateway tools are the node's declared tools plus submit_output, under either executor's naming.
  const gateway = (t: string) => /^(azhi_)?(ci_list-runs_1|submit_output)$/.test(t);
  const errorClass = d.run.error?.class ?? null;
  const pass = d.run.state === f.expect.state && (f.expect.error_class === undefined || errorClass === f.expect.error_class) && (f.expect.output === undefined || canonicalJson(last?.output) === canonicalJson(f.expect.output));
  return {
    fixture: f.id,
    kind: f.kind,
    executor: e,
    pass,
    state: d.run.state,
    error_class: errorClass,
    latency_ms: Math.round(latency),
    model_requests: calls.length,
    input_tokens: d.usage.input_tokens,
    output_tokens: d.usage.output_tokens,
    cost_usd: d.usage.cost.amount,
    usage_complete: !d.run.flags?.usage_incomplete,
    non_gateway_tools: [...offered].filter((t) => !gateway(t)),
    ...(pass ? {} : { note: `expected ${f.expect.state}${f.expect.error_class ? ` (${f.expect.error_class})` : ''}; error: ${d.run.error?.message ?? 'none'}` }),
  };
}

function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}

function report(results: Result[], fixtureCount: number): string {
  const by = (e: Executor) => results.filter((r) => r.executor === e);
  const ran = EXECUTORS.filter((e) => by(e).length);
  const fmtCost = (rs: Result[]) => {
    const known = rs.filter((r) => r.cost_usd !== null);
    return known.length === rs.length ? `$${known.reduce((n, r) => n + r.cost_usd!, 0).toFixed(4)} (estimated)` : `unavailable for ${rs.length - known.length} of ${rs.length} runs`;
  };
  const lines = [
    '# Executor comparison',
    '',
    `Generated by \`npm run compare\` on ${new Date().toISOString().slice(0, 10)}. ${fixtureCount} fixtures, each played through ${ran.length > 1 ? `${ran.slice(0, -1).join(', ')} and ${ran.at(-1)}` : ran[0]}.`,
    '',
    '`agent` is the platform model agent on Anthropic, `agent-openai` the same agent on OpenAI, and `opencode` the OpenCode adapter (Anthropic). Each talks to a scripted endpoint for its provider that plays the same steps, so this measures the adapter contract, not model quality: whether the run ends the way the platform promises, how many model requests and tokens it takes, how long the agent node runs, and which tools the model is offered. Profile pricing is a placeholder ($3 / $15 per million tokens) so the cost column shows whether cost can be estimated at all.',
    '',
    '## Summary',
    '',
    '| | ' + ran.join(' | ') + ' |',
    '|---|' + ran.map(() => '---').join('|') + '|',
    '| Contract success | ' + ran.map((e) => `${by(e).filter((r) => r.pass).length} / ${by(e).length}`).join(' | ') + ' |',
    '| Median agent-node latency | ' + ran.map((e) => `${median(by(e).map((r) => r.latency_ms))} ms`).join(' | ') + ' |',
    '| Model requests | ' + ran.map((e) => String(by(e).reduce((n, r) => n + r.model_requests, 0))).join(' | ') + ' |',
    '| Total cost | ' + ran.map((e) => fmtCost(by(e))).join(' | ') + ' |',
    '| Runs with complete usage | ' + ran.map((e) => `${by(e).filter((r) => r.usage_complete).length} / ${by(e).length}`).join(' | ') + ' |',
    '| Runs offered a non-gateway tool | ' + ran.map((e) => `${by(e).filter((r) => r.non_gateway_tools.length).length} / ${by(e).length}`).join(' | ') + ' |',
    '',
    'Agent-node latency for OpenCode includes starting a fresh `opencode serve` process for every node (isolated home, config and password), which dominates on a scripted model. OpenCode also makes more model requests than its tool loop needs (for example to title the session); they are counted and priced like any other.',
    '',
    '## Ambient tools',
    '',
    'The model agent (on either provider) only ever offers the node\'s declared tools and `submit_output`, by construction. OpenCode ships built-in tools (shell, file edits, web fetch and others); the adapter turns every one of them off in its generated config and denies all permissions, so the run plan marks ambient-tool control as **harness** coverage, not **enforced**: Azhi relies on OpenCode honouring its own config. The "non-gateway tool" row above is the observed check of that: it counts runs in which the model request listed any tool that is not a gateway tool. Usage for OpenCode is always flagged incomplete because cache and reasoning tokens are not reported through the adapter.',
    '',
    '## By scenario',
    '',
    '| Scenario | ' + ran.map((e) => `${e} pass`).join(' | ') + ' | ' + ran.map((e) => `${e} median ms`).join(' | ') + ' |',
    '|---|' + ran.map(() => '---').join('|') + '|' + ran.map(() => '---').join('|') + '|',
  ];
  for (const kind of [...new Set(results.map((r) => r.kind))]) {
    const rs = (e: Executor) => by(e).filter((r) => r.kind === kind);
    lines.push(`| ${kind} | ` + ran.map((e) => `${rs(e).filter((r) => r.pass).length} / ${rs(e).length}`).join(' | ') + ' | ' + ran.map((e) => String(median(rs(e).map((r) => r.latency_ms)))).join(' | ') + ' |');
  }
  const failures = results.filter((r) => !r.pass);
  lines.push('', '## Failures', '', failures.length ? failures.map((r) => `- ${r.executor} ${r.fixture}: ended ${r.state}${r.error_class ? ` (${r.error_class})` : ''}. ${r.note}`).join('\n') : 'None.', '');
  lines.push('Raw results are in the JSON file next to this report.', '');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
