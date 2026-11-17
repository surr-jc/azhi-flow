import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { staticCatalog } from '../src/gateway/types.js';
import { loadExample } from '../src/api/examples.js';
import { renderReport } from '../src/runtime/report.js';
// @ts-expect-error plain ESM script without types
import { probeCommand } from '../examples/pr-review-adversarial/scripts/build_probe_command.mjs';

/**
 * The adversarial PR review example (examples/pr-review-adversarial): it compiles against its own tool registration,
 * takes the requirement as a GitHub issue, a Jira key or text, can never merge or approve, runs probes with a trusted
 * runner whose compressed command is kept in sync with its source, and decides the verdict with plain rules.
 */
const PKG = 'examples/pr-review-adversarial';
const read = (f: string) => readFileSync(`${PKG}/${f}`, 'utf8');

const py = (script: string, input: unknown) => {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', `${PKG}/scripts/${script}`], { input: JSON.stringify(input), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe('pr-review-adversarial example: package', () => {
  it('compiles with no error or warning and is listed by the marketplace', () => {
    const pkg = packageFromDirectory(PKG);
    const tools = parse(read('azhi.config.yaml')).tools;
    const result = compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg, catalog: staticCatalog(tools) });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // The one expected warning is the unfilled {{probe_setup_command}} setting, which the example install fills.
    expect(result.diagnostics.filter((d) => d.severity === 'warning' && d.code !== 'unfilled_setting')).toEqual([]);
    const e = loadExample('pr-review-adversarial')!;
    expect(e.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['pr', 'source', 'ticket', 'requirements', 'conformance', 'static', 'strategy', 'surface', 'probe', 'probe_results', 'verify', 'triage', 'summarize', 'review', 'post']));
    expect((e.config.tools ?? []).map((t) => t.id).sort()).toEqual(['github.comment-on-pr', 'github.get-issue', 'github.get-pull-request', 'jira.get-issue', 'ticket.normalize']);
  });

  it('can only read and comment: no merge, push, approval or write tool but the pinned comment', () => {
    const wf = parse(read('workflow.yaml'));
    const tools = wf.nodes.filter((n: any) => n.type === 'tool').map((n: any) => n.tool);
    expect(wf.nodes.some((n: any) => n.type === 'approval')).toBe(false);
    expect(tools.filter((t: string) => /merge|push|create|label|close/.test(t))).toEqual([]);
    const post = wf.nodes.find((n: any) => n.id === 'post');
    expect(post.guard).toBe('args.repo == inputs.repo && args.number == inputs.pr');
    expect(wf.nodes.find((n: any) => n.id === 'notify').guard).toBe('args.channel == config.channel');
    // The config grants no write token other than the comment token.
    expect(parse(read('azhi.config.yaml')).secrets).toEqual(['github-read-token', 'github-comment-token', 'jira-api-token', 'github-copilot-token', 'slack-bot-token']);
  });

  it('takes the requirement as a Jira key, a GitHub issue, typed text, or nothing (inferred), and routes each', () => {
    const wf = parse(read('workflow.yaml'));
    const node = (id: string) => wf.nodes.find((n: any) => n.id === id);
    expect(node('source').routes).toEqual({ jira: ['jira_issue'], github: ['github_issue'], text: ['text_pass'], inferred: ['inferred_pass'] });
    expect(node('ticket').merge).toBe('any');
    expect(wf.inputs.required).toEqual(['repo', 'pr']);
    const issue = new RegExp(wf.inputs.properties.issue.pattern);
    for (const ok of ['', 'PAY-142', '17', 'acme/shop#17', 'https://github.com/acme/shop/issues/17']) expect(issue.test(ok), ok).toBe(true);
    for (const bad of ['pay-1', 'PAY-', '17; rm -rf', 'acme/shop', '$(id)']) expect(issue.test(bad), bad).toBe(false);
    expect(wf.inputs.properties.requirement.maxLength).toBe(20000);
  });

  it('has the strategist decide how to probe, read-only, before the planner and the prober, and advise only', () => {
    const wf = parse(read('workflow.yaml'));
    const node = (id: string) => wf.nodes.find((n: any) => n.id === id);
    expect(node('should_review').routes.review).toContain('strategy');
    expect(node('strategy').workspace.mode).toBeUndefined();
    expect(node('strategy').profile).toBe('probe-strategist@1');
    for (const id of ['surface', 'probe', 'triage']) expect(JSON.stringify(node(id).input), id).toContain('nodes.strategy.output');
    // Its setup command is never wired into a command: the only test command is the workflow's own.
    expect(JSON.stringify(wf.nodes.filter((n: any) => n.id !== 'triage'))).not.toMatch(/strategy.output.setup_command/);
    expect(JSON.stringify(wf.nodes.find((n: any) => n.id === 'probe').workspace.test)).not.toContain('strategy');
    const profile = parse(read('profiles/probe-strategist@1.yaml'));
    expect(profile.harness.opencode.tools).toEqual(['read', 'grep', 'glob', 'skill']);
  });

  it('puts the probe agent in a writable checkout whose test command is the compressed trusted runner', () => {
    const wf = parse(read('workflow.yaml'));
    const probe = wf.nodes.find((n: any) => n.id === 'probe');
    expect(probe.workspace.mode).toBe('write');
    expect(probe.workspace.test.attempts).toBe(1);
    // Every other agent reads a checkout and cannot write.
    for (const id of ['conformance', 'static', 'surface', 'verify']) expect(wf.nodes.find((n: any) => n.id === id).workspace.mode).toBeUndefined();
    // The workflow's command is the setting, then the runner as `scripts/build_probe_command.mjs` builds it from probe-runner.cjs.
    expect(probe.workspace.test.command).toBe(`{{probe_setup_command}} && ${probeCommand()}`);
  });
});

describe('pr-review-adversarial example: probe runner', () => {
  const run = (probes: Record<string, Record<string, string>>) => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-probes-'));
    for (const [id, files] of Object.entries(probes)) {
      mkdirSync(join(dir, '.azhi-probes', id), { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, '.azhi-probes', id, name), body);
    }
    // The way the worker runs a test command: one string, through a shell.
    const r = spawnSync(probeCommand(), { cwd: dir, shell: true, encoding: 'utf8', timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
    const results: Record<string, any> = {};
    for (const m of r.stdout.matchAll(/^AZHI_PROBE (\{.*\})$/gm)) results[JSON.parse(m[1]!).id] = JSON.parse(m[1]!);
    return { results, done: /^AZHI_PROBES_DONE (\d+)$/m.exec(r.stdout)?.[1] };
  };
  const manifest = (id: string, file: string) => JSON.stringify({ id, kind: 'library', argv: ['node', `.azhi-probes/${id}/${file}`] });

  it('records REPRODUCED, HELD and every way a probe can fail to be a result, and always exits 0', () => {
    const { results, done } = run({
      P1: { 'probe.json': manifest('P1', 'p.cjs'), 'p.cjs': "console.log('noise');console.log('REPRODUCED: exit 3 on empty input');" },
      P2: { 'probe.json': manifest('P2', 'p.cjs'), 'p.cjs': "console.log('HELD: rejected with 400');" },
      P3: { 'probe.json': manifest('P3', 'p.cjs'), 'p.cjs': "throw new Error('boom');" },
      P4: { 'probe.json': JSON.stringify({ id: 'P4', argv: ['azhi-no-such-program'] }) },
      P5: { 'probe.json': JSON.stringify({ id: 'P9', argv: ['node', '-v'] }) },
    });
    expect(done).toBe('5');
    expect(results.P1).toMatchObject({ state: 'reproduced', observed: 'exit 3 on empty input' });
    expect(results.P2).toMatchObject({ state: 'held', observed: 'rejected with 400' });
    expect(results.P3).toMatchObject({ state: 'not_run' });
    expect(results.P3.reason).toMatch(/no REPRODUCED or HELD line/);
    expect(results.P4).toMatchObject({ state: 'not_run' });
    expect(results.P4.reason).toMatch(/could not start/);
    expect(results.P5.reason).toMatch(/id equal to its folder/);
  });

  it('runs nothing and says so when no probes were written', () => {
    const { results, done } = run({});
    expect(done).toBe('0');
    expect(results).toEqual({});
  });
});

const scenario = (o: Record<string, unknown> = {}) => ({ id: 'P1', title: 'Empty header', class: 'input_boundary', likelihood: 'high', impact: 'high', mechanism: 'src/parse.ts:12 indexes [0] of an empty list', invariant: 'header is non-empty', probe_kind: 'library', decisive: true, probe_plan: 'call parse("")', ...o });
const surface = (scenarios: unknown[] = [scenario()], o: Record<string, unknown> = {}) => ({ summary: 's', executable: true, surface: [{ element: 'entry_point', what: 'parse(@bob)', where: 'src/parse.ts:12' }], scenarios, deferred: [{ title: 'Retry order', why: 'low likelihood' }], ...o });
const out = (runner: string, files: unknown[] = [], exit = 0) => ({ workspace: { files, tests: { status: 'passed', command: 'x', exit_code: exit, attempts: 1, output: runner } } });
const line = (o: Record<string, unknown>) => `AZHI_PROBE ${JSON.stringify(o)}\n`;
const done = 'AZHI_PROBES_DONE 1\n';
const pfile = (id: string) => [
  { path: `.azhi-probes/${id}/probe.json`, status: 'added', content: JSON.stringify({ id, argv: ['node', `.azhi-probes/${id}/p.mjs`] }), encoding: 'utf-8' },
  { path: `.azhi-probes/${id}/p.mjs`, status: 'added', content: 'console.log("REPRODUCED: x")', encoding: 'utf-8' },
];

describe('pr-review-adversarial example: ticket and probe results', () => {
  it('builds one ticket: issue first, then the typed text, then the PR description as inferred', () => {
    const pr = { title: 'Add `@team` retry', body: 'Retries 3 times', url: 'https://github.com/acme/shop/pull/1' };
    const issue = { source: 'jira', key: 'PAY-1', title: 'Retry payments', description: 'Retry 3 times', labels: ['a'], url: 'u', priority: '', reporter: '', status: '' };
    expect(py('ticket.py', { normalized: issue, comments: [], text: 'ignored', pr })).toMatchObject({ origin: 'issue', source: 'jira', key: 'PAY-1', title: 'Retry payments' });
    expect(py('ticket.py', { normalized: { ...issue, source: 'github', key: 'acme/shop#4' }, comments: [{ author: 'x', body: 'y' }], text: '', pr })).toMatchObject({ source: 'github', comments: [{ author: 'x', body: 'y' }] });
    expect(py('ticket.py', { normalized: null, comments: [], text: 'First line\nsecond', pr })).toMatchObject({ origin: 'text', source: 'text', title: 'First line', description: 'First line\nsecond' });
    const inferred = py('ticket.py', { normalized: null, comments: [], text: '  ', pr });
    expect(inferred).toMatchObject({ origin: 'inferred', source: 'pr', description: 'Retries 3 times' });
    // The title shown in a comment can neither mention anyone nor break out of code formatting.
    expect(inferred.shown_title).toBe("Add '@​team' retry");
  });

  it('reads the runner: reproduced, held, not run, and a CLI is stronger evidence than a library call', () => {
    const r = (kind: string, runner: string) => py('probe_results.py', { surface: surface([scenario({ probe_kind: kind })]), probe: { scenarios: [{ id: 'P1', mode: 'executed', static_result: 'none', reason: 'r' }], ...out(runner + done, pfile('P1')) } });
    const lib = r('library', line({ id: 'P1', state: 'reproduced', exit: 0, observed: 'IndexError @x' }));
    expect(lib.scenarios[0]).toMatchObject({ state: 'reproduced', level: 'L3 - Executed', observed: 'IndexError @​x', command: 'node .azhi-probes/P1/p.mjs' });
    expect(lib.findings).toHaveLength(1);
    expect(lib.findings[0]).toMatchObject({ id: 'P1', severity: 'blocker', path: 'src/parse.ts', line: 12 });
    expect(lib.findings[0].probe).toContain('REPRODUCED');
    expect(r('cli', line({ id: 'P1', state: 'reproduced', exit: 0, observed: 'x' })).scenarios[0].level).toBe('L4 - Reproduced');
    expect(r('library', line({ id: 'P1', state: 'held', exit: 0, observed: 'ok' })).scenarios[0]).toMatchObject({ state: 'ruled_out', level: 'L3 - Executed' });
    const nr = r('library', line({ id: 'P1', state: 'not_run', reason: 'timed out' }));
    expect(nr.scenarios[0]).toMatchObject({ state: 'unproven', reason: 'timed out' });
    expect(nr.findings).toEqual([]);
  });

  it('is unproven when the runner never ran, a probe was missing, or the checkout changed outside .azhi-probes/', () => {
    const base = (probe: unknown) => py('probe_results.py', { surface: surface(), probe });
    const claim = [{ id: 'P1', mode: 'executed', static_result: 'none', reason: 'r' }];
    expect(base({ scenarios: claim, ...out('npm ERR! setup failed\n', [], 1) }).scenarios[0].reason).toMatch(/runner did not run.*exit code 1/);
    expect(base({ scenarios: claim, ...out(done, []) }).scenarios[0].reason).toMatch(/no probe was written/);
    expect(base({ scenarios: [] }).scenarios[0].reason).toMatch(/did not report/);
    const dirty = base({ scenarios: claim, ...out(line({ id: 'P1', state: 'reproduced', observed: 'x' }) + done, [...pfile('P1'), { path: 'src/parse.ts', status: 'modified', content: '', encoding: 'utf-8' }]) });
    expect(dirty.dirty_paths).toEqual(['src/parse.ts']);
    expect(dirty.scenarios[0]).toMatchObject({ state: 'unproven' });
    expect(dirty.scenarios[0].reason).toMatch(/outside \.azhi-probes/);
    expect(dirty.findings).toEqual([]);
  });

  it('takes a static walk as it was reported: ruled out is L2, anything else is unproven', () => {
    const st = (res: string) => py('probe_results.py', { surface: surface([scenario({ probe_kind: 'static', class: 'deployment' })]), probe: { scenarios: [{ id: 'P1', mode: 'static', static_result: res, reason: 'walked src/a.ts:3' }] } }).scenarios[0];
    expect(st('ruled_out')).toMatchObject({ state: 'ruled_out', level: 'L2 - Ruled out', mode: 'static' });
    expect(st('unproven')).toMatchObject({ state: 'unproven', level: 'none' });
  });
});

describe('pr-review-adversarial example: triage rules', () => {
  const criteria = [{ id: 'R1', text: 'Retries 3 times', kind: 'functional', testable: true }, { id: 'R2', text: 'Logs each retry', kind: 'nonfunctional', testable: true }];
  const req = { summary: 's', criteria, ambiguous: [] };
  const conf = (statuses: string[], findings: unknown[] = []) => ({ reviewer: 'conformance', summary: '', criteria: criteria.map((c, i) => ({ id: c.id, status: statuses[i], evidence: 'e' })), findings });
  const gap = (id = 'G1', criterion = 'R2') => ({ id, criterion, severity: 'major', path: 'src/a.ts', line: 3, title: 'No log', detail: 'd', scenario: 's' });
  const check = (id: string, verdict: string, confidence = 90, severity?: string) => ({ id, verdict, confidence, evidence: `${verdict} ${id}`, ...(severity ? { severity } : {}) });
  const probesFor = (state: string, o: Record<string, unknown> = {}) => ({ runner_ran: true, dirty_paths: [], findings: [], scenarios: [{ id: 'P1', title: 'Empty header', class: 'input_boundary', impact: 'high', likelihood: 'high', decisive: true, kind: 'library', mechanism: 'src/parse.ts:12', mode: 'executed', state, level: state === 'ruled_out' ? 'L3 - Executed' : state === 'reproduced' ? 'L3 - Executed' : 'none', observed: 'o', reason: 'because', command: 'node p.mjs', probe_files: [{ path: '.azhi-probes/P1/p.mjs', content: '' }], ...o }] });
  const strategy = { summary: 's', stack: 'Spring Boot 3, Maven, JUnit 5', build_tool: 'maven', probeable: true, launch: { argv: ['java', '@target/probe.args', '{probe}'], file: 'Probe.java', notes: '' }, seams: ['MockMvc standalone'], avoid: ['@SpringBootTest'], setup_command: 'mvn -q test-compile `x` @me' };
  const triage = (o: Record<string, unknown> = {}) => py('triage.py', { origin: 'issue', strategy, requirements: req, conformance: conf(['met', 'met']), reviews: [{ reviewer: 'static', summary: '', findings: [] }], probes: probesFor('ruled_out'), surface: surface(), checks: [], min_confidence: 80, ...o });

  it('holds only when a probe executed and passed: green, approve, and never "proven correct"', () => {
    const t = triage();
    expect(t).toMatchObject({ verdict: 'holds', light: 'green', recommendation: 'approve', coverage: { met: 2, total: 2 } });
    expect(t.verdict_note).toMatch(/not proof/);
    expect(t.attack_surface[0].what).toBe('parse(@​bob)');
  });

  it('is unproven when the only passes were walked by reading, when a decisive probe did not run, or when nothing was tried', () => {
    expect(triage({ probes: probesFor('ruled_out', { level: 'L2 - Ruled out', mode: 'static' }) })).toMatchObject({ verdict: 'unproven', light: 'yellow', recommendation: 'comment' });
    const decisive = triage({ probes: probesFor('unproven', { reason: 'timed out' }) });
    expect(decisive).toMatchObject({ verdict: 'unproven', light: 'yellow' });
    expect(decisive.unproven[0].reason).toBe('timed out');
    expect(triage({ probes: probesFor('unproven', { decisive: false }) }).verdict).toBe('unproven'); // nothing executed and passed
    expect(triage({ probes: { runner_ran: true, dirty_paths: [], findings: [], scenarios: [] } }).verdict).toBe('unproven');
    expect(triage({ probes: { runner_ran: true, dirty_paths: [], findings: [], scenarios: [] }, surface: surface([], { executable: false }) })).toMatchObject({ verdict: 'holds', verdict_note: expect.stringMatching(/Nothing executable changed/) });
  });

  it('breaks only on a failure the refuter confirmed at the bar; a refuted or doubtful one is unproven, and the grade is the refuter\'s', () => {
    const p = probesFor('reproduced', { observed: 'exit 3' });
    const hit = triage({ probes: p, checks: [check('P1', 'confirmed', 92, 'major')] });
    expect(hit).toMatchObject({ verdict: 'breaks', light: 'red', recommendation: 'request_changes' });
    expect(hit.reproduced[0]).toMatchObject({ id: 'P1', severity: 'SHOULD', confidence: 92, level: 'L3 - Executed', observed: 'exit 3' });
    expect(triage({ probes: p, checks: [check('P1', 'confirmed', 92)] }).reproduced[0].severity).toBe('MUST'); // impact high, no regrade
    const refuted = triage({ probes: p, checks: [check('P1', 'refuted', 95)] });
    expect(refuted).toMatchObject({ verdict: 'unproven', reproduced: [] });
    expect(refuted.unproven[0].reason).toMatch(/refuted it/);
    expect(refuted.dropped.map((d: any) => d.id)).toEqual(['P1']);
    for (const checks of [[check('P1', 'confirmed', 79)], [check('P1', 'unverifiable', 90)], []]) expect(triage({ probes: p, checks }).verdict).toBe('unproven');
  });

  it('keeps only confirmed review findings, sets aside the unverifiable ones, and regrades by the refuter', () => {
    const f = (id: string, severity = 'major') => ({ id, severity, path: 'a.ts', line: 1, title: `T ${id}`, detail: 'd', scenario: 's' });
    const t = triage({ reviews: [{ reviewer: 'static', summary: '', findings: [f('C1', 'major'), f('C2'), f('S1'), f('S2')] }], checks: [check('C1', 'confirmed', 90, 'blocker'), check('C2', 'refuted', 90), check('S1', 'unverifiable', 0)] });
    expect(t.findings.map((x: any) => [x.id, x.severity, x.reported_severity])).toEqual([['C1', 'blocker', 'major']]);
    expect(t.dropped.map((x: any) => x.id)).toEqual(['C2']);
    expect(t.check_by_hand.map((x: any) => x.id)).toEqual(['S1', 'S2']);
    expect(t.check_by_hand[1].why).toBe('the refuter returned no check');
    expect(t).toMatchObject({ light: 'red', stats: { found: 4, kept: 1, unverified: 2, dropped: 1 } });
    // Only unverified findings: yellow, never red.
    expect(triage({ reviews: [{ reviewer: 'static', summary: '', findings: [f('S1')] }], checks: [] }).light).toBe('yellow');
  });

  it('computes requirement coverage: a confirmed gap is missing (red), a refuted gap is met, an unconfirmed one is unverifiable', () => {
    const missing = triage({ conformance: conf(['met', 'missing'], [gap()]), checks: [check('G1', 'confirmed', 90, 'major')] });
    expect(missing.criteria.map((c: any) => c.status)).toEqual(['met', 'missing']);
    expect(missing).toMatchObject({ light: 'red', coverage: { met: 1, missing: 1, total: 2 } });
    const refuted = triage({ conformance: conf(['met', 'missing'], [gap()]), checks: [check('G1', 'refuted', 90)] });
    expect(refuted.criteria[1].status).toBe('met');
    expect(refuted.light).toBe('green');
    const doubtful = triage({ conformance: conf(['met', 'partial'], [gap()]), checks: [check('G1', 'confirmed', 50)] });
    expect(doubtful.criteria[1].status).toBe('unverifiable');
    expect(doubtful.light).toBe('yellow');
    // A criterion the conformance reviewer skipped is not assumed met.
    const skipped = triage({ conformance: { reviewer: 'conformance', summary: '', criteria: [{ id: 'R1', status: 'met', evidence: 'e' }], findings: [] } });
    expect(skipped.criteria[1]).toMatchObject({ status: 'unverifiable', evidence: expect.stringMatching(/did not assess/) });
  });

  it('shows the setup advice of the strategist only when probes were expected and none gave a result, and never as something to run', () => {
    const hint = (probes: unknown, s: unknown = strategy) => triage({ probes, strategy: s }).setup_hint;
    expect(hint(probesFor('ruled_out'))).toMatchObject({ show: false });
    const none = { ...probesFor('unproven', { reason: 'setup failed' }), runner_ran: false };
    expect(hint(none)).toMatchObject({ show: true, stack: 'Spring Boot 3, Maven, JUnit 5', command: "mvn -q test-compile 'x' @​me" });
    expect(hint(none, { ...strategy, setup_command: '' }).show).toBe(false);
    expect(hint({ ...probesFor('unproven', { mode: 'static' }), runner_ran: false }).show).toBe(false); // nothing was meant to execute
  });

  it('treats an inferred requirement as advisory: a gap against the PR description never turns the light red', () => {
    const t = triage({ origin: 'inferred', conformance: conf(['met', 'missing'], [gap()]), checks: [check('G1', 'confirmed', 90, 'blocker')] });
    expect(t.findings[0]).toMatchObject({ id: 'G1', severity: 'minor', reported_severity: 'major' });
    expect(t).toMatchObject({ light: 'green', coverage: { inferred: true } });
  });

  it('voids the probes and turns the light yellow when the checkout changed outside .azhi-probes/', () => {
    const p = { ...probesFor('unproven', { reason: 'probe invalid' }), dirty_paths: ['src/a.ts'] };
    expect(triage({ probes: p })).toMatchObject({ verdict: 'unproven', light: 'yellow' });
  });

  it('renders the PR comment and the Slack message from the decided facts, with no model-written verdict', () => {
    const p = probesFor('reproduced', { observed: 'exit 3', command: 'node .azhi-probes/P1/p.mjs' });
    const t = triage({ conformance: conf(['met', 'missing'], [gap()]), probes: p, checks: [check('P1', 'confirmed', 92), check('G1', 'confirmed', 88, 'major')] });
    const view = { icon: '🔴', headline: 'No-go, changes requested', verdict_word: 'Breaks', origin_label: 'GitHub issue', dirty: false, dirty_count: 0 };
    const pr = { repo: 'acme/shop', number: 7, title: 'Retry', url: 'https://github.com/acme/shop/pull/7', head_sha: 'abc123', base_ref: 'main' };
    const review = { summary: 'Retries payments; one failure reproduced.', next_steps: ['Fix P1: guard the empty header', 'Log each retry (R2)'] };
    const md = renderReport(read('templates/review.md'), { pr, ticket: { title: 'Retry payments', url: 'https://github.com/acme/shop/issues/4' }, ambiguous: ['How many retries?'], review, t, view }, { asOf: {}, format: 'markdown' }).markdown;
    expect(md).toContain('## 🔴 Azhi adversarial review: No-go, changes requested');
    expect(md).toContain('**Adversarial verdict:** Breaks');
    expect(md).toContain('#### P1 - MUST - L3 - Executed: Empty header');
    expect(md).toContain('- **Probe:** `node .azhi-probes/P1/p.mjs`');
    expect(md).toContain('| R2 | Logs each retry | missing |');
    expect(md).toContain('1 of 2 met, 1 missing');
    expect(md).toContain('- Fix P1: guard the empty header');
    expect(md).toContain('How many retries?');
    expect(md).not.toContain('recommends setting');
    const none = triage({ probes: { ...probesFor('unproven', { reason: 'setup failed' }), runner_ran: false } });
    const hinted = renderReport(read('templates/review.md'), { pr, ticket: { title: 'T', url: '' }, ambiguous: [], review, t: none, view }, { asOf: {}, format: 'markdown' }).markdown;
    expect(hinted).toContain('recommends setting `probe_setup_command` to: `mvn -q test-compile');
    expect(md).not.toMatch(/\{\{|\}\}/);
    const slack = renderReport(read('templates/slack.md'), { pr, review, t, view }, { asOf: {}, format: 'markdown' }).markdown;
    expect(slack).toContain('🔴 No-go, changes requested (adversarial verdict: Breaks)');
    expect(slack).toContain('- MUST P1: Empty header');
    // A clean run says Holds is not proof, and shows no empty sections.
    const clean = renderReport(read('templates/review.md'), { pr, ticket: { title: 'T', url: '' }, ambiguous: [], review: { summary: 'Fine.', next_steps: [] }, t: triage(), view: { ...view, icon: '🟢', headline: 'Go', verdict_word: 'Holds' } }, { asOf: {}, format: 'markdown' }).markdown;
    expect(clean).not.toContain('### Reproduced failures');
    expect(clean).not.toContain('### Next steps');
    expect(clean).toContain('"Holds" is not proof of correctness');
  });
});
