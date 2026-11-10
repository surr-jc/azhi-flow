import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGithub } from '../src/testing/fake-github.js';
import type { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * examples/sdd-factory on the engine, with scripted models: brainstorm, plan, approvals, the split of each epic, the
 * Stories in order, each stacked on the one before, the release check and the summary. The brainstorm and planning
 * agents run on the scripted provider (no checkout, no OpenCode). The three children are small stand-ins with the ids
 * and inputs of the published ones: `issue-splitter` (a split epic returns sub-issues from a script; a single-issue epic
 * creates its issue with the real `github.create-issue` tool on a fake GitHub, so the parent sees a tool step the way an
 * engine run stores it), `sdd-story` (signed off or sent back by ticket number) and `ai-sdlc-factory-verify`. So these
 * tests prove the factory's wiring - ordering, stacking, stopping, joining the ends of the run - and nothing about what
 * the children do. Runs under `npm run test:local`.
 */
const up = await temporalAvailable();
const PKG = 'examples/sdd-factory';
const REPO = 'acme/shop';
const CHANNEL = 'C0FACTORY';
const READ_TOKEN = 'ghp_read_factory_1';
const WRITE_TOKEN = 'ghp_write_factory_2';

const brainstorm = {
  summary: 'Customers cannot pay by card yet.',
  questions: [{ question: 'Which countries must be supported?', why: 'Decides the payment provider.', recommendation: 'The UK only, to start' }],
  approaches: [{ name: 'Walking skeleton first', delivers: 'One card payment end to end.', cost: 'Little polish.', leaves_out: 'Refunds', recommended: true, reason: 'Smallest path a user can walk.', counter: 'Refunds wait.' }],
  assumptions: ['Cards only'],
  unknowns: ['Which provider'],
  greenfield: false,
};
const prd = {
  title: 'Pay by card',
  summary: 'Customers can pay by card.',
  problem: 'Customers cannot pay.',
  owner: { value: null, evidence: 'No CODEOWNERS found' },
  goals: ['Take a card payment'],
  non_goals: ['Refunds'],
  invariants: ['An order is never charged twice'],
  journeys: [{ name: 'Checkout', steps: ['Add to cart', 'Pay', 'See receipt'] }],
  risks: [],
  open_questions: [],
  walking_skeleton: 'cart -> pay -> receipt',
  epics: [
    { title: 'Take a card payment', goal: 'A card payment succeeds.', scope: ['src/pay'], acceptance_criteria: ['A card payment succeeds'], depends_on_note: '' },
    { title: 'Send receipts', goal: 'Email a receipt.', scope: ['src/mail'], acceptance_criteria: ['A receipt is emailed'], depends_on_note: 'Needs the first epic merged' },
  ],
};

/** The factory with both agents on the scripted provider and no repository checkout, and the Slack channel filled in. */
function factoryPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-factory-e2e-'));
  cpSync(PKG, dir, { recursive: true });
  const wfPath = join(dir, 'workflow.yaml');
  const wf = parse(readFileSync(wfPath, 'utf8').replaceAll('{{slack_channel}}', CHANNEL));
  for (const n of wf.nodes) if (n.type === 'agent') (delete n.executor, delete n.workspace);
  writeFileSync(wfPath, stringify(wf));
  const script = (profile: string, output: unknown) =>
    writeFileSync(join(dir, `profiles/${profile}.yaml`), JSON.stringify({ ...parse(readFileSync(`${PKG}/profiles/${profile}.yaml`, 'utf8')), model: { provider: 'scripted' }, script: [{ output }] }));
  script('brainstormer@1', brainstorm);
  script('release-planner@1', prd);
  return dir;
}

let nonce = 0;
const standIn = (id: string, inputs: string, nodes: string, files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), `azhi-${id}-stub-`));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'workflow.yaml'), `# stand-in ${++nonce}\nschema_version: "2.0"\nid: ${id}\ninputs:\n  type: object\n  properties:\n${inputs}\nnodes:\n${nodes}`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `scripts/${name}`), text);
  return dir;
};
const ECHO = 'import json, sys\nprint(json.dumps(json.load(sys.stdin)))\n';

/**
 * A stand-in issue-splitter. Epic 1 is split into `perEpic` sub-issues (numbers 1000 x epic + 1 ..., clear of the numbers the fake GitHub gives new issues); epic 2 is, in
 * 'mixed', a single issue created with the github.create-issue tool. 'fail' makes the run fail, 'none' leaves every
 * slice out at the approval.
 */
type SplitKind = 'mixed' | 'split' | 'many' | 'fail' | 'none';
function splitterPackage(kind: SplitKind): string {
  const perEpic = kind === 'many' ? 11 : kind === 'none' ? 0 : 2;
  return standIn(
    'issue-splitter',
    '    repo: {type: string}\n    text: {type: string}\n    base_branch: {type: string}\n  required: [repo, text]',
    `  - id: epic
    type: script
    runtime: python
    entrypoint: scripts/epic.py
    input: {map: "{'text': inputs.text}"}
    output_schema: {type: object, properties: {n: {type: integer}}, required: [n]}
  - id: kind
    type: condition
    expression: "${kind === 'mixed' ? "nodes.epic.output.n == 2 ? 'single' : 'split'" : "'split'"}"
    routes: {single: [single_create], split: [split_create]}
    default: split
  - id: single_create
    type: tool
    tool: github.create-issue@1
    arguments: {repo: {ref: inputs.repo}, title: One issue, body: Body, labels: [ready]}
    guard: "args.repo == inputs.repo"
  - id: split_create
    type: script
    runtime: python
    entrypoint: scripts/split.py
    input: {map: "{'n': nodes.epic.output.n}"}
    output_schema: {type: object}
  - id: outcome
    type: script
    runtime: python
    entrypoint: scripts/outcome.py
    retry: {max_attempts: 1}
    merge: any
    depends_on: [single_create, split_create]
    input: {map: "{'split': has(nodes.split_create) ? nodes.split_create.output : null}"}
    output_schema: {type: object}
`,
    {
      'epic.py': 'import json, re, sys\nd = json.load(sys.stdin)\nm = re.search(r"# Epic (\\d+):", d["text"])\nprint(json.dumps({"n": int(m.group(1)) if m else 0}))\n',
      'split.py': `import json, sys\nn = json.load(sys.stdin)["n"]\nprint(json.dumps({"created": [{"number": n * 1000 + i, "title": "Epic %d slice %d" % (n, i), "url": "https://github.com/acme/shop/issues/%d" % (n * 1000 + i), "linked": True} for i in range(1, ${perEpic} + 1)]}))\n`,
      'outcome.py': kind === 'fail' ? 'raise SystemExit("the splitter failed")\n' : 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"message": "split", "parent_comment": "split", "parent_number": 0, "created": (d.get("split") or {}).get("created", [])}))\n',
    },
  );
}

/**
 * A stand-in sdd-story: it echoes its inputs (the Story's text and the extra files included), then signs the Story off,
 * sends it back (`fail`) or fails (`crash`). A Story is identified by its issue number (source github) or by its
 * story_key (source files; its number is the N of `<release>-sN`); `fail` and `crash` list numbers or keys.
 */
function storyPackage(fail: Array<number | string>, crash: Array<number | string>): string {
  return standIn(
    'sdd-story',
    `    source: {type: string}
    ticket: {type: string}
    repo: {type: string}
    base_branch: {type: string}
    stack_on: {type: string}
    mode: {type: string}
    story_key: {type: string}
    story_title: {type: string}
    story_body: {type: string}
    extra_files: {type: array, items: {type: object, properties: {path: {type: string}, content: {type: string}}, required: [path, content]}}
  required: [ticket, repo]`,
    `  - id: echo
    type: script
    runtime: python
    entrypoint: scripts/echo.py
    input: {map: "{'source': inputs.source, 'ticket': inputs.ticket, 'repo': inputs.repo, 'base_branch': inputs.base_branch, 'stack_on': has(inputs.stack_on) ? inputs.stack_on : '', 'mode': has(inputs.mode) ? inputs.mode : '', 'story_key': has(inputs.story_key) ? inputs.story_key : '', 'story_title': has(inputs.story_title) ? inputs.story_title : '', 'story_body': has(inputs.story_body) ? inputs.story_body : '', 'extra_files': has(inputs.extra_files) ? inputs.extra_files : []}"}
    output_schema: {type: object}
  - id: result
    type: script
    runtime: python
    entrypoint: scripts/result.py
    retry: {max_attempts: 1}
    input: {map: "{'ticket': inputs.ticket, 'source': inputs.source, 'story_key': has(inputs.story_key) ? inputs.story_key : ''}"}
    output_schema: {type: object}
`,
    {
      'echo.py': ECHO,
      'result.py': `import json, sys
d = json.load(sys.stdin)
if d["source"] == "files":
    ident = d["story_key"]
    number = int(ident.rsplit("-s", 1)[1])
    branch = "azhi/" + ident
else:
    ident = d["ticket"]
    number = int(ident.split("#")[1])
    branch = "azhi/" + ident.replace("#", "-")
if number in ${JSON.stringify(crash)} or ident in ${JSON.stringify(crash)}:
    raise SystemExit("the Story crashed")
if number in ${JSON.stringify(fail)} or ident in ${JSON.stringify(fail)}:
    print(json.dumps({"status": "sent_back", "reason": "tests_failed", "branch": None, "head_sha": None, "pr_number": None, "pr_url": None}))
else:
    print(json.dumps({"status": "signed_off", "reason": "signed_off", "branch": branch, "head_sha": "c" * 40, "pr_number": number, "pr_url": "https://github.com/acme/shop/pull/%d" % number}))
`,
    },
  );
}

/**
 * A stand-in sdd-breakdown: it echoes its inputs and returns the Stories as data, and writes nothing. 'ok': epic 1 gives
 * two Stories, epic 2 one. 'not_code': epic 2 is not a code change. 'none': every slice of every epic was left out.
 * 'many': seven Stories per epic (one more than a breakdown may return). 'fail': the run fails. 'nostep': it ends
 * without a stories step, as a child whose plan approval was rejected does.
 */
type BreakKind = 'ok' | 'not_code' | 'none' | 'many' | 'fail' | 'nostep';
function breakdownPackage(kind: BreakKind): string {
  const stories = `import json, sys
d = json.load(sys.stdin)
n = d["epic"]
kind = ${JSON.stringify(kind)}
per = 7 if kind == "many" else (2 if n == 1 else 1)
if kind == "none":
    out = {"status": "none", "epic": n, "release": d["release"], "stories": []}
elif kind == "not_code" and n == 2:
    out = {"status": "not_code", "epic": n, "release": d["release"], "stories": []}
else:
    out = {"status": "ok", "epic": n, "release": d["release"], "stories": [{"slice": i, "title": "Epic %d slice %d" % (n, i), "body": "Body of epic %d slice %d\\n\\n- do it" % (n, i)} for i in range(1, per + 1)]}
print(json.dumps(out))
`;
  return standIn(
    'sdd-breakdown',
    '    repo: {type: string}\n    text: {type: string}\n    base_branch: {type: string}\n    epic: {type: integer}\n    release: {type: string}\n  required: [repo, text]',
    `  - id: echo
    type: script
    runtime: python
    entrypoint: scripts/echo.py
    input: {map: "{'repo': inputs.repo, 'text': inputs.text, 'base_branch': has(inputs.base_branch) ? inputs.base_branch : '', 'epic': has(inputs.epic) ? inputs.epic : 0, 'release': has(inputs.release) ? inputs.release : ''}"}
    output_schema: {type: object}
${
  kind === 'nostep'
    ? ''
    : `  - id: stories
    type: script
    runtime: python
    entrypoint: scripts/stories.py
    retry: {max_attempts: 1}
    input: {map: "{'epic': has(inputs.epic) ? inputs.epic : 0, 'release': has(inputs.release) ? inputs.release : ''}"}
    output_schema: {type: object}
`
}`,
    { 'echo.py': ECHO, 'stories.py': kind === 'fail' ? 'raise SystemExit("the breakdown failed")\n' : stories },
  );
}

/** A stand-in ai-sdlc-factory-verify: it echoes its inputs and grades the release as asked. */
function verifyPackage(kind: 'verified' | 'failed' | 'boom'): string {
  const verdict = { verified: { overall: 'verified', counts: { pass: 3, fail: 0, unavailable: 0 }, ci_status: 'success' }, failed: { overall: 'failed', counts: { pass: 2, fail: 1, unavailable: 0 }, ci_status: 'success' }, boom: null }[kind];
  return standIn(
    'ai-sdlc-factory-verify',
    '    repo: {type: string}\n    staging_branch: {type: string}\n    journeys: {type: string}\n    propose_fix: {type: boolean}\n  required: [repo, staging_branch, journeys]',
    `  - id: echo
    type: script
    runtime: python
    entrypoint: scripts/echo.py
    input: {map: "{'repo': inputs.repo, 'staging_branch': inputs.staging_branch, 'journeys': inputs.journeys, 'propose_fix': has(inputs.propose_fix) ? inputs.propose_fix : true}"}
    output_schema: {type: object}
  - id: verdict
    type: script
    runtime: python
    entrypoint: scripts/verdict.py
    retry: {max_attempts: 1}
    input: {map: "{'repo': inputs.repo}"}
    output_schema: {type: object}
`,
    { 'echo.py': ECHO, 'verdict.py': verdict ? `import json, sys\nsys.stdin.read()\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify(verdict))})))\n` : 'raise SystemExit("the release check failed")\n' },
  );
}

async function waitForApprovalOn(api: ApiClient, runId: string, node: string) {
  for (let i = 0; i < 900; i++) {
    const d = await api.get<any>(`/v1/runs/${runId}`);
    if (d.run.state === 'waiting' && d.run.flags?.waiting_reason?.reason === 'approval' && d.run.flags.waiting_reason.node === node) return d;
    if (['failed', 'succeeded', 'cancelled', 'expired'].includes(d.run.state)) throw new Error(`run ended ${d.run.state} before waiting on ${node}: ${JSON.stringify(d.run.error)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} never waited on ${node}`);
}

const SLOW = 300_000;
const GOAL = 'Let customers pay by card';
/** The release id of the run being asserted on: the slug of the plan's title and six random hex characters, read from the run by `start`. */
let RELEASE = '';

describe.skipIf(!up)('sdd-factory end to end (scripted agents, stand-in children)', () => {
  let h: Harness;
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const saved = process.env.AZHI_EGRESS_ALLOW;
  let factory: string;
  /** What the person was shown at the brainstorm, in the last run started. */
  let brainstormRequest: any;

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub({ runs: [], pulls: [], issues: [] }, { token: [READ_TOKEN, WRITE_TOKEN] });
    h = await startHarness();
    await h.api.put('/v1/secrets/github-read-token', { value: READ_TOKEN });
    await h.api.put('/v1/secrets/github-write-token', { value: WRITE_TOKEN });
    const tools = [...parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools, ...parse(readFileSync('examples/issue-splitter/azhi.config.yaml', 'utf8')).tools.filter((t: any) => t.id === 'github.create-issue')];
    for (const t of tools) {
      if (t.transport?.config?.repos) t.transport.config = { ...t.transport.config, repos: [REPO], api_url: gh.url };
      await h.api.post('/v1/tools', t);
    }
    const v = await uploadDir(h.api, factoryPackage());
    expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
    factory = v.version.id;
  }, 120_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.AZHI_EGRESS_ALLOW;
    else process.env.AZHI_EGRESS_ALLOW = saved;
    await h?.stop();
    await gh?.stop();
  });

  interface Setup {
    split?: SplitKind;
    fail?: Array<number | string>;
    crash?: Array<number | string>;
    verify?: 'verified' | 'failed' | 'boom';
    /** The tracker: github (the default) or files. */
    source?: 'github' | 'files';
    breakdown?: BreakKind;
  }
  /** Publishes the stand-ins, then starts a run and answers the brainstorm and the plan (`drop`: the epics left out). */
  const start = async (s: Setup = {}, drop = '') => {
    for (const dir of [splitterPackage(s.split ?? 'mixed'), breakdownPackage(s.breakdown ?? 'ok'), storyPackage(s.fail ?? [], s.crash ?? []), verifyPackage(s.verify ?? 'verified')]) {
      const v = await uploadDir(h.api, dir);
      expect(v.ok, JSON.stringify(v.diagnostics)).toBe(true);
      await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
    }
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: factory, inputs: { source: s.source ?? 'github', repo: REPO, base_branch: 'dev', goal: GOAL } });
    const asked = await waitForApprovalOn(h.api, run_id, 'brainstorm_review');
    brainstormRequest = asked.approvals.find((a: any) => a.node_id === 'brainstorm_review').request;
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'brainstorm_review', decision: 'approved', data: { approach: 'Walking skeleton first', answers: 'UK only.' } });
    await waitForApprovalOn(h.api, run_id, 'prd_review');
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'prd_review', decision: 'approved', data: { drop } });
    // The release id has random characters, so each case reads the one its run was given before it asserts on names.
    RELEASE = '';
    for (let i = 0; i < 300 && !RELEASE; i++) {
      const id = out(await h.api.get<any>(`/v1/runs/${run_id}`), 'release')?.id;
      if (typeof id === 'string') RELEASE = id;
      else await new Promise((r) => setTimeout(r, 200));
    }
    return run_id;
  };
  const approve = (run_id: string, node: string, decision: 'approved' | 'rejected' = 'approved', data?: Record<string, unknown>) => h.api.post(`/v1/runs/${run_id}/approvals`, { node, decision, ...(data ? { data } : {}) });
  const out = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id && a.state === 'succeeded').at(-1)?.output;
  const state = (d: any, id: string) => d.attempts.filter((a: any) => a.node_id === id).at(-1)?.state ?? 'not run';
  const stories = (d: any) => d.attempts.filter((a: any) => /^deliver_stories_\d+_story$/.test(a.node_id) && a.state === 'succeeded').sort((a: any, b: any) => a.node_id.localeCompare(b.node_id, undefined, { numeric: true })).map((a: any) => a.output);
  const posted = (since: number) => h.slack.messages.slice(since).map((m) => m.text);
  const childrenOf = (d: any, workflow: string) => d.children.filter((c: any) => c.workflow === workflow);
  const breakdowns = (d: any) => d.attempts.filter((a: any) => /^breakdown_epics_\d+_breakdown$/.test(a.node_id) && a.state === 'succeeded').sort((a: any, b: any) => a.node_id.localeCompare(b.node_id, undefined, { numeric: true })).map((a: any) => a.output);
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `${RELEASE}-s${i + 1}`);

  it('delivers every Story in order, each stacked on the one before, then checks the release and says what to merge', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({ split: 'mixed' });

    // Epic 1 is split into two sub-issues; epic 2 fits one pull request, so its issue comes from a tool step.
    const asked = await waitForApprovalOn(h.api, run_id, 'autonomy');
    expect(gh.created).toHaveLength(1);
    const single = gh.created[0]!.number;
    const refs = [`${REPO}#1001`, `${REPO}#1002`, `${REPO}#${single}`];
    const request = asked.approvals.find((a: any) => a.node_id === 'autonomy').request;
    expect(request.payload).toMatchObject({ repository: REPO, base_branch: 'dev', prd_title: 'Pay by card' });
    expect(request.payload.stories.map((s: any) => s.ref)).toEqual(refs);
    expect(request.payload.stories.map((s: any) => s.epic)).toEqual([1, 1, 2]);
    expect(request.payload.stories.map((s: any) => Object.keys(s).sort())).toEqual([['epic', 'ref', 'title'], ['epic', 'ref', 'title'], ['epic', 'ref', 'title']]);
    expect(request.message).not.toContain('No tracker');
    expect(asked.attempts.filter((a: any) => a.node_id.startsWith('deliver_stories') && a.state === 'succeeded')).toEqual([]);
    await approve(run_id, 'autonomy');

    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');

    // One Story per round, in order: the first is stacked on the base branch, each later one on the branch before.
    const ran = stories(done);
    expect(ran.map((s: any) => s.nodes.echo.ticket)).toEqual(refs);
    const branches = [1001, 1002, single].map((n) => `azhi/${REPO.replace('/', '/')}-${n}`);
    expect(ran.map((s: any) => s.nodes.echo.stack_on)).toEqual(['dev', branches[0], branches[1]]);
    for (const s of ran) expect(s.nodes.echo).toMatchObject({ source: 'github', repo: REPO, base_branch: 'dev', mode: 'supervised', story_key: '', story_title: '', story_body: '', extra_files: [] });
    expect(out(done, 'deliver_stories')).toMatchObject({ outcome: 'done', count: 3 });
    // github is as before: the splitter ran, the breakdown did not, no breakdown file is carried, the summary names issues.
    expect(childrenOf(done, 'sdd-breakdown')).toEqual([]);
    expect(out(done, 'breakdown_doc')).toEqual({ files: [] });
    expect(state(done, 'breakdown_epics_1_breakdown')).toBe('skipped');
    expect(out(done, 'summary').breakdown_path).toBeNull();

    // The release check reads the top branch of the stack, the plan's journeys and invariants, and asks for no fix ticket.
    const check = out(done, 'release_check');
    expect(check.nodes.echo).toMatchObject({ repo: REPO, staging_branch: branches[2], propose_fix: false });
    expect(check.nodes.echo.journeys).toContain('An order is never charged twice');
    expect(check.nodes.echo.journeys).toContain('Checkout');

    expect(out(done, 'summary')).toMatchObject({ status: 'delivered', signed_off: 3, total: 3, stopped_at: null, release: { status: 'verified' } });
    expect(out(done, 'summary').stack.map((s: any) => s.number)).toEqual([1001, 1002, single]);
    const text = posted(before).join('\n');
    expect(text).toContain('Delivered 3 of 3 Stories; release check verified.');
    expect(text).toContain('Pull request stack, merge them in this order:');
    expect(text.indexOf('#1001')).toBeLessThan(text.indexOf('#1002'));
    expect(text).toContain('Nothing was merged.');

    // Every child is a run of its own, started by this one.
    expect(childrenOf(done, 'issue-splitter').map((c: any) => c.state)).toEqual(['succeeded', 'succeeded']);
    expect(childrenOf(done, 'sdd-story').map((c: any) => c.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(childrenOf(done, 'ai-sdlc-factory-verify').map((c: any) => c.state)).toEqual(['succeeded']);
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review', 'autonomy']);
  }, SLOW);

  describe('source files: no tracker, the breakdown is committed in the first pull request', () => {
    const titles = ['Epic 1 slice 1', 'Epic 1 slice 2', 'Epic 2 slice 1'];

    it('delivers three Stories stacked in order, keyed <release>-sN, with the breakdown only in the first one', async () => {
      const before = h.slack.messages.length;
      const reqs = gh.requests.length;
      const createdBefore = gh.created.length;
      const run_id = await start({ source: 'files', breakdown: 'ok' });

      const asked = await waitForApprovalOn(h.api, run_id, 'autonomy');
      const request = asked.approvals.find((a: any) => a.node_id === 'autonomy').request;
      // The approval lists ref, title and epic - the key as the ref - and no Story text.
      expect(request.payload.stories).toEqual(keys(3).map((ref, i) => ({ ref, title: titles[i], epic: [1, 1, 2][i] })));
      expect(JSON.stringify(request)).not.toContain('Body of epic');
      expect(request.message).toContain('No tracker');
      expect(request.message).toContain(`docs/release/${RELEASE}/breakdown.md`);
      await approve(run_id, 'autonomy');

      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.error).toBeNull();
      expect(done.run.state).toBe('succeeded');
      expect(RELEASE).toMatch(/^pay-by-card-[0-9a-f]{6}$/);
      expect(out(done, 'release')).toEqual({ id: RELEASE });

      // The epics were broken down by the breakdown child, one after the other, and no issue was made.
      expect(childrenOf(done, 'sdd-breakdown').map((c: any) => c.state)).toEqual(['succeeded', 'succeeded']);
      expect(childrenOf(done, 'issue-splitter')).toEqual([]);
      expect(state(done, 'split_epics_1_split')).toBe('skipped');
      const bd = breakdowns(done);
      expect(bd.map((b: any) => b.nodes.echo.epic)).toEqual([1, 2]);
      for (const b of bd) expect(b.nodes.echo).toMatchObject({ repo: REPO, base_branch: 'dev', release: RELEASE });
      expect(bd[0].nodes.echo.text).toContain('# Epic 1: Take a card payment');
      expect(gh.requests.slice(reqs).filter((r) => r.includes('/issues'))).toEqual([]);
      expect(gh.created).toHaveLength(createdBefore);

      // The order: global numbers, the key as the ref, the Story text as inputs.
      const order = out(done, 'order');
      expect(order).toMatchObject({ ok: true, count: 3 });
      expect(order.stories.map((s: any) => [s.ref, s.number, s.epic])).toEqual(keys(3).map((k, i) => [k, i + 1, [1, 1, 2][i]]));

      // One Story per round, in order, each stacked on the one before; the first on the base branch.
      const ran = stories(done);
      expect(ran.map((s: any) => s.nodes.echo.story_key)).toEqual(keys(3));
      expect(ran.map((s: any) => s.nodes.echo.story_title)).toEqual(titles);
      expect(ran.map((s: any) => s.nodes.echo.stack_on)).toEqual(['dev', `azhi/${keys(3)[0]}`, `azhi/${keys(3)[1]}`]);
      for (const [i, s] of ran.entries()) expect(s.nodes.echo, `Story ${i + 1}`).toMatchObject({ source: 'files', ticket: '', repo: REPO, base_branch: 'dev', mode: 'supervised' });
      expect(ran[0].nodes.echo.story_body).toBe('Body of epic 1 slice 1\n\n- do it');
      expect(ran[2].nodes.echo.story_body).toBe('Body of epic 2 slice 1\n\n- do it');
      expect(out(done, 'deliver_stories')).toMatchObject({ outcome: 'done', count: 3 });

      // The breakdown document rides on Story 1 only.
      const first = ran[0].nodes.echo.extra_files;
      expect(first).toHaveLength(1);
      expect(first[0].path).toBe(`docs/release/${RELEASE}/breakdown.md`);
      expect(first[0].content).toContain('Pay by card');
      for (const t of titles) expect(first[0].content).toContain(t);
      expect(first[0].content).toContain(`### ${keys(3)[2]}: Epic 2 slice 1`);
      expect(ran[1].nodes.echo.extra_files).toEqual([]);
      expect(ran[2].nodes.echo.extra_files).toEqual([]);

      // The release check reads the top branch of the stack.
      expect(out(done, 'release_check').nodes.echo).toMatchObject({ repo: REPO, staging_branch: `azhi/${keys(3)[2]}`, propose_fix: false });

      // The summary names the Stories by key and says where the plan is.
      const summary = out(done, 'summary');
      expect(summary).toMatchObject({ status: 'delivered', signed_off: 3, total: 3, stopped_at: null, breakdown_path: `docs/release/${RELEASE}/breakdown.md`, release: { status: 'verified' } });
      expect(summary.stories.map((s: any) => s.ref)).toEqual(keys(3));
      expect(summary.stack.map((s: any) => s.label)).toEqual(keys(3));
      const text = posted(before).join('\n');
      for (const k of keys(3)) expect(text).toContain(k);
      expect(text).not.toContain('• #1');
      expect(text).toContain('the breakdown of the release is in the first pull request');
      expect(text).toContain(`docs/release/${RELEASE}/breakdown.md`);
      expect(text).toContain('Nothing was merged.');
      expect(childrenOf(done, 'sdd-story').map((c: any) => c.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review', 'autonomy']);
    }, SLOW);

    it("passes the person's auto mode to every Story", async () => {
      const run_id = await start({ source: 'files', breakdown: 'ok' }, '2');
      await waitForApprovalOn(h.api, run_id, 'autonomy');
      await approve(run_id, 'autonomy', 'approved', { mode: 'auto' });
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state).toBe('succeeded');
      expect(out(done, 'mode')).toEqual({ mode: 'auto' });
      const ran = stories(done);
      expect(ran.map((s: any) => s.nodes.echo.story_key)).toEqual(keys(2));
      for (const s of ran) expect(s.nodes.echo).toMatchObject({ source: 'files', mode: 'auto' });
      // Epic 2 was left out, so the one breakdown that ran is epic 1; its two Stories are numbered from 1.
      expect(breakdowns(done).map((b: any) => b.nodes.echo.epic)).toEqual([1]);
      expect(ran[0].nodes.echo.extra_files).toHaveLength(1);
      expect(ran[1].nodes.echo.extra_files).toEqual([]);
    }, SLOW);

    it('stops at the first Story that is not signed off, by key: nothing is stacked on it and the release is not checked', async () => {
      const before = h.slack.messages.length;
      const run_id = await start({ source: 'files', breakdown: 'ok', fail: [2] });
      await waitForApprovalOn(h.api, run_id, 'autonomy');
      await approve(run_id, 'autonomy');
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.error).toBeNull();
      expect(done.run.state).toBe('succeeded');
      expect(stories(done).map((s: any) => s.nodes.echo.story_key)).toEqual(keys(3).slice(0, 2));
      expect(out(done, 'deliver_stories')).toMatchObject({ outcome: 'stop', count: 2 });
      expect(state(done, 'deliver_stories_3_story')).toBe('skipped');
      for (const id of ['journeys', 'release_check']) expect(state(done, id), id).toBe('skipped');
      const summary = out(done, 'summary');
      expect(summary).toMatchObject({ status: 'stopped', signed_off: 1, total: 3, stopped_at: keys(3)[1], headline: `Stopped at ${keys(3)[1]} (tests_failed): 1 of 3 Stories signed off.`, breakdown_path: `docs/release/${RELEASE}/breakdown.md` });
      expect(summary.stack.map((s: any) => s.label)).toEqual([keys(3)[0]]);
      expect(posted(before).join('\n')).toContain(`Stopped at ${keys(3)[1]} (tests_failed)`);
    }, SLOW);

    it('treats a Story whose run fails as not signed off', async () => {
      const run_id = await start({ source: 'files', breakdown: 'ok', crash: [1] });
      await waitForApprovalOn(h.api, run_id, 'autonomy');
      await approve(run_id, 'autonomy');
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state).toBe('succeeded');
      expect(childrenOf(done, 'sdd-story').map((c: any) => c.state)).toEqual(['failed']);
      expect(out(done, 'summary')).toMatchObject({ status: 'stopped', signed_off: 0, total: 3, stopped_at: keys(3)[0], breakdown_path: null });
    }, SLOW);

    it('delivers nothing when a breakdown fails: no question, no Story, a summary that says the epic could not be handled', async () => {
      const before = h.slack.messages.length;
      const reqs = gh.requests.length;
      const run_id = await start({ source: 'files', breakdown: 'fail' });
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.error).toBeNull();
      expect(done.run.state).toBe('succeeded');
      expect(childrenOf(done, 'sdd-breakdown').map((c: any) => c.state)).toEqual(['failed']);
      expect(out(done, 'breakdown_epics')).toMatchObject({ outcome: 'stop', count: 1 });
      expect(out(done, 'order')).toMatchObject({ ok: false, problem: 'split_failed', count: 0, stories: [] });
      expect(childrenOf(done, 'sdd-story')).toEqual([]);
      expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
      expect(out(done, 'summary')).toMatchObject({ status: 'stopped', stopped_at: 'split_failed', stories: [], breakdown_path: null });
      expect(posted(before).join('\n')).toContain('could not be split');
      expect(gh.requests.slice(reqs).filter((r) => r.includes('/issues'))).toEqual([]);
    }, SLOW);

    it('delivers nothing when a breakdown ends without a stories step (a rejected plan)', async () => {
      const run_id = await start({ source: 'files', breakdown: 'nostep' });
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state).toBe('succeeded');
      expect(childrenOf(done, 'sdd-breakdown').map((c: any) => c.state)).toEqual(['succeeded']);
      expect(out(done, 'breakdown_epics_1_breakdown_outcome')).toMatchObject({ status: 'failed', reason: 'no_stories_step', stories: [] });
      expect(out(done, 'order')).toMatchObject({ ok: false, problem: 'split_failed' });
      expect(childrenOf(done, 'sdd-story')).toEqual([]);
      expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
    }, SLOW);

    it('fails the epic whose breakdown returns more than 6 Stories, and does not break down the epic after it', async () => {
      const run_id = await start({ source: 'files', breakdown: 'many' });
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state).toBe('succeeded');
      // Three epics of six Stories are 18, so a files release never reaches the 20-Story refusal through the loop: the
      // per-epic cap is what stops an oversized breakdown (the order step's own refusal of 21 is a unit test).
      expect(childrenOf(done, 'sdd-breakdown')).toHaveLength(1);
      expect(out(done, 'breakdown_epics_1_breakdown_outcome')).toMatchObject({ status: 'failed', reason: 'bad_story', stories: [] });
      expect(out(done, 'order')).toMatchObject({ ok: false, problem: 'split_failed', stories: [] });
      expect(childrenOf(done, 'sdd-story')).toEqual([]);
      expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
    }, SLOW);

    it('delivers only the code epics: an epic that is not a code change gives no Story and does not stop the run', async () => {
      const run_id = await start({ source: 'files', breakdown: 'not_code' });
      await waitForApprovalOn(h.api, run_id, 'autonomy');
      await approve(run_id, 'autonomy');
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state).toBe('succeeded');
      expect(childrenOf(done, 'sdd-breakdown').map((c: any) => c.state)).toEqual(['succeeded', 'succeeded']);
      expect(out(done, 'breakdown_epics_2_breakdown_outcome')).toMatchObject({ status: 'ok', reason: 'not_code', stories: [] });
      expect(out(done, 'order')).toMatchObject({ ok: true, count: 2 });
      expect(stories(done).map((s: any) => s.nodes.echo.story_key)).toEqual(keys(2));
      expect(out(done, 'summary')).toMatchObject({ status: 'delivered', signed_off: 2, total: 2 });
    }, SLOW);

    it('delivers nothing, and asks nothing, when no epic gives a Story or the person leaves every epic out', async () => {
      for (const [setup, drop] of [[{ source: 'files', breakdown: 'none' }, ''], [{ source: 'files', breakdown: 'ok' }, '1,2']] as const) {
        const run_id = await start(setup, drop);
        const done = await waitForRun(h.api, run_id, SLOW);
        expect(done.run.error, drop).toBeNull();
        expect(done.run.state, drop).toBe('succeeded');
        expect(out(done, 'order'), drop).toMatchObject({ ok: true, count: 0 });
        expect(childrenOf(done, 'sdd-story'), drop).toEqual([]);
        expect(done.approvals.map((a: any) => a.node_id), drop).toEqual(['brainstorm_review', 'prd_review']);
        expect(out(done, 'summary'), drop).toMatchObject({ status: 'nothing_to_deliver', total: 0, breakdown_path: null });
        expect(out(done, 'breakdown_doc'), drop).toEqual({ files: [] });
      }
    }, SLOW * 2);

    it('refuses a files run with a ticket, or with no goal, before it starts', async () => {
      await expect(h.api.post('/v1/runs', { version: factory, inputs: { source: 'files', repo: REPO, base_branch: 'dev', goal: GOAL, ticket: `${REPO}#4` } })).rejects.toThrow();
      await expect(h.api.post('/v1/runs', { version: factory, inputs: { source: 'files', repo: REPO, base_branch: 'dev' } })).rejects.toThrow();
    }, SLOW);
  });

  it('shows each brainstorm question with its recommendation, and runs every Story in the mode the person chose', async () => {
    const run_id = await start({ split: 'split' }, '2');
    expect(brainstormRequest.payload.questions).toEqual([{ question: 'Which countries must be supported?', why: 'Decides the payment provider.', recommendation: 'The UK only, to start' }]);
    expect(brainstormRequest.message).toContain('question(s)');
    const asked = await waitForApprovalOn(h.api, run_id, 'autonomy');
    expect(asked.approvals.find((a: any) => a.node_id === 'autonomy').request.message).toContain('auto');
    // Choosing auto is a decision of its own; the schema refuses anything else.
    await expect(approve(run_id, 'autonomy', 'approved', { mode: 'unattended' })).rejects.toThrow(/decision schema/);
    await approve(run_id, 'autonomy', 'approved', { mode: 'auto' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'mode')).toEqual({ mode: 'auto' });
    const ran = stories(done);
    expect(ran).toHaveLength(2);
    for (const s of ran) expect(s.nodes.echo.mode).toBe('auto');
    expect(out(done, 'summary')).toMatchObject({ status: 'delivered', signed_off: 2, total: 2 });
  }, SLOW);

  it('stops at the first Story that is not signed off: nothing is stacked on it, the release is not checked, and the summary names it', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({ split: 'mixed', fail: [1002] });
    await waitForApprovalOn(h.api, run_id, 'autonomy');
    await approve(run_id, 'autonomy');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');

    expect(stories(done).map((s: any) => s.nodes.echo.ticket)).toEqual([`${REPO}#1001`, `${REPO}#1002`]);
    expect(out(done, 'deliver_stories')).toMatchObject({ outcome: 'stop', reason: 'A Story was not signed off', count: 2 });
    expect(state(done, 'deliver_stories_3_story')).toBe('skipped');
    for (const id of ['journeys', 'release_check']) expect(state(done, id), id).toBe('skipped');
    expect(childrenOf(done, 'ai-sdlc-factory-verify')).toEqual([]);

    const summary = out(done, 'summary');
    expect(summary).toMatchObject({ status: 'stopped', signed_off: 1, total: 3, stopped_at: `${REPO}#1002`, headline: `Stopped at ${REPO}#1002 (tests_failed): 1 of 3 Stories signed off.` });
    expect(summary.stories.map((s: any) => s.status)).toEqual(['signed_off', 'sent_back', 'not_started']);
    expect(summary.stack.map((s: any) => s.number)).toEqual([1001]);
    expect(posted(before).join('\n')).toContain(`Stopped at ${REPO}#1002 (tests_failed)`);
  }, SLOW);

  it('treats a Story whose run fails as not signed off, and goes no further', async () => {
    const run_id = await start({ split: 'split', crash: [1001] });
    await waitForApprovalOn(h.api, run_id, 'autonomy');
    await approve(run_id, 'autonomy');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(childrenOf(done, 'sdd-story').map((c: any) => c.state)).toEqual(['failed']);
    expect(out(done, 'summary')).toMatchObject({ status: 'stopped', signed_off: 0, total: 4, stopped_at: `${REPO}#1001`, headline: `Stopped at ${REPO}#1001 (story_failed): 0 of 4 Stories signed off.` });
    expect(out(done, 'summary').stack).toEqual([]);
  }, SLOW);

  it('says the release check failed, or could not run, instead of calling the release verified', async () => {
    for (const [verify, status] of [['failed', 'failed'], ['boom', 'unavailable']] as const) {
      const before = h.slack.messages.length;
      const run_id = await start({ split: 'split', verify });
      await waitForApprovalOn(h.api, run_id, 'autonomy');
      await approve(run_id, 'autonomy');
      const done = await waitForRun(h.api, run_id, SLOW);
      expect(done.run.state, verify).toBe('succeeded');
      expect(out(done, 'summary'), verify).toMatchObject({ status: 'delivered', signed_off: 4, total: 4, release: { status } });
      expect(posted(before).join('\n'), verify).toContain(`Delivered 4 of 4 Stories; release check ${status}.`);
    }
  }, SLOW * 2);

  it('delivers nothing when the person leaves every epic out: no split, no question, a summary that says so', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({}, '1,2');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(out(done, 'epics')).toMatchObject({ count: 0 });
    expect(done.children).toEqual([]);
    for (const id of ['split_epics_1_split', 'autonomy', 'deliver_stories_1_story']) expect(state(done, id), id).not.toBe('succeeded');
    expect(out(done, 'order')).toMatchObject({ ok: true, count: 0 });
    expect(out(done, 'summary')).toMatchObject({ status: 'nothing_to_deliver', total: 0 });
    expect(posted(before).join('\n')).toContain('The plan has no Story to deliver.');
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
  }, SLOW);

  it('refuses a plan of more than 20 Stories before anything is delivered', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({ split: 'many' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(childrenOf(done, 'issue-splitter')).toHaveLength(2);
    expect(out(done, 'order')).toMatchObject({ ok: false, problem: 'too_many', too_many: true, count: 22, stories: [] });
    expect(done.children.filter((c: any) => c.workflow === 'sdd-story')).toEqual([]);
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
    expect(out(done, 'summary')).toMatchObject({ status: 'stopped', stopped_at: 'too_many' });
    expect(posted(before).join('\n')).toContain('more than 20 Stories');
  }, SLOW);

  it('delivers nothing when a splitter fails, and does not split the epics after it', async () => {
    const run_id = await start({ split: 'fail' });
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(childrenOf(done, 'issue-splitter').map((c: any) => c.state)).toEqual(['failed']);
    expect(out(done, 'split_epics')).toMatchObject({ outcome: 'stop', count: 1 });
    expect(out(done, 'order')).toMatchObject({ ok: false, problem: 'split_failed', count: 0 });
    expect(done.approvals.map((a: any) => a.node_id)).toEqual(['brainstorm_review', 'prd_review']);
    expect(out(done, 'summary')).toMatchObject({ status: 'stopped', stopped_at: 'split_failed' });
  }, SLOW);

  it('delivers nothing when the person does not approve the Stories, and says so', async () => {
    const before = h.slack.messages.length;
    const run_id = await start({ split: 'split' });
    await waitForApprovalOn(h.api, run_id, 'autonomy');
    await approve(run_id, 'autonomy', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    expect(childrenOf(done, 'sdd-story')).toEqual([]);
    expect(state(done, 'mode')).toBe('skipped');
    expect(out(done, 'summary')).toMatchObject({ status: 'not_started', stopped_at: 'autonomy', total: 4, signed_off: 0 });
    expect(posted(before).join('\n')).toContain('Delivery was not approved; no Story was delivered.');
  }, SLOW);

  it('still posts a summary when the person rejects the brainstorm: nothing was planned, split or delivered', async () => {
    const before = h.slack.messages.length;
    for (const dir of [splitterPackage('split'), storyPackage([], []), verifyPackage('verified')]) {
      const v = await uploadDir(h.api, dir);
      await h.api.post(`/v1/versions/${v.version.id}/publish`, {});
    }
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: factory, inputs: { source: 'github', repo: REPO, base_branch: 'dev', goal: 'Let customers pay by card' } });
    await waitForApprovalOn(h.api, run_id, 'brainstorm_review');
    await approve(run_id, 'brainstorm_review', 'rejected');
    const done = await waitForRun(h.api, run_id, SLOW);
    expect(done.run.state).toBe('succeeded');
    for (const id of ['plan_release', 'prd_review', 'epics', 'order']) expect(state(done, id), id).toBe('skipped');
    expect(done.children).toEqual([]);
    expect(out(done, 'summary')).toMatchObject({ status: 'not_started', stopped_at: 'plan' });
    expect(posted(before).join('\n')).toContain('The run ended before the Stories were ordered; nothing was delivered.');
  }, SLOW);
});
