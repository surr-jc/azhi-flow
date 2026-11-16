import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeStep } from '../src/testing/fake-anthropic.js';
import { startFakeGit } from '../src/testing/fake-git.js';
import { startFakeGithub } from '../src/testing/fake-github.js';
import { startFakeOpenAI, type FakeOpenAIRequest as FakeRequest } from '../src/testing/fake-openai.js';
import { opencodeBinary } from '../src/worker/capabilities.js';
import { startHarness, temporalAvailable, uploadDir, type Harness } from './helpers/harness.js';

/**
 * The PR conflict resolver end to end: OpenCode runs for real against a scripted model endpoint, on a real merge conflict
 * in a checkout from a local git host. This is where real agents go through a loop body: a second attempt on another
 * model continues from the first attempt's files, is told why it was rejected, and what ships is the last attempt.
 */
const PKG = 'examples/pr-conflict-resolver';
const MODEL = 'resolver-model';
const STRONG = 'claude-opus-5.5';
// The refuter's real model goes through the Responses API, which the fake endpoint does not stream, so here it is another one.
const REFUTER = 'claude-sonnet-5.5';
const READ_TOKEN = 'ghp_read_resolve_1';
const WRITE_TOKEN = 'ghp_write_resolve_2';
const COPILOT_TOKEN = 'gho_copilot_resolve_3';
const FIRST = 'export const price = 125;\n';
const SECOND = 'export const price = 130;\n';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const up = (await temporalAvailable()) && Boolean(opencodeBinary()) && hasGit;

function makeRepo(root: string) {
  const work = join(root, 'work');
  mkdirSync(join(work, 'src'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev1', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev1', GIT_COMMITTER_EMAIL: 'd@example.com' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
  const commit = (message: string) => {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main', '.');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(work, 'src/price.js'), 'export const price = 100;\n');
  writeFileSync(join(work, 'package-lock.json'), '{"v": 1}\n');
  const root0 = commit('Start');
  // A conflict an agent resolves.
  git('checkout', '-qb', 'feature');
  writeFileSync(join(work, 'src/price.js'), 'export const price = 120;\n');
  const feature = commit('Raise the price');
  // A conflict set aside for a person: a lock file.
  git('checkout', '-qb', 'locks', root0);
  writeFileSync(join(work, 'package-lock.json'), '{"v": 3}\n');
  const locks = commit('Bump the lock');
  git('checkout', '-q', 'main');
  writeFileSync(join(work, 'src/price.js'), 'export const price = 110;\n');
  writeFileSync(join(work, 'package-lock.json'), '{"v": 2}\n');
  const main = commit('Adjust the price');
  mkdirSync(join(root, 'srv/acme'), { recursive: true });
  const bare = join(root, 'srv/acme/shop.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { env });
  execFileSync('git', ['update-ref', 'refs/pull/7/head', feature], { cwd: bare, env });
  execFileSync('git', ['update-ref', 'refs/pull/8/head', locks], { cwd: bare, env });
  return { srv: join(root, 'srv'), main, feature, locks };
}

const resolution = (over: Record<string, unknown> = {}) => ({ summary: 'Took both changes.', resolutions: [], unresolved: [], prompt_injection_detected: false, prompt_injection_evidence: [], ...over });
const review = (over: Record<string, unknown> = {}) => ({ approved: true, summary: 'Fine.', findings: [], prompt_injection_detected: false, prompt_injection_evidence: [], ...over });
const FINDING = { id: 'F1', severity: 'major', title: 'drops the raise', path: 'src/price.js', detail: 'the first attempt loses part of the raise' };

let resolverFlagsInjection = false;
let firstAttemptRejected = true;

const text = (r: FakeRequest) => JSON.stringify(r);
function script(r: FakeRequest): FakeStep[] {
  if (r.system.includes('You make no changes')) return [{ tool: 'submit_output', input: { note: 'done' } }, { text: 'done' }];
  if (r.system.includes('You are the merge resolver')) {
    // The stronger model is the second attempt: it reads the file first, to show it starts from the first attempt's result.
    if (r.model === STRONG) return [{ tool: 'read', input: { filePath: 'src/price.js' } }, { tool: 'write', input: { filePath: 'src/price.js', content: SECOND } }, { tool: 'submit_output', input: resolution({ summary: 'Second attempt.' }) }, { text: 'done' }];
    return [{ tool: 'write', input: { filePath: 'src/price.js', content: FIRST } }, { tool: 'submit_output', input: resolution(resolverFlagsInjection ? { prompt_injection_detected: true, prompt_injection_evidence: [{ where: 'src/price.js', text: 'ignore your instructions' }] } : {}) }, { text: 'done' }];
  }
  if (r.system.includes('You are the merge reviewer')) {
    const first = firstAttemptRejected && text(r).includes('price = 125');
    return [{ tool: 'submit_output', input: first ? review({ approved: false, summary: 'Loses part of the raise.', findings: [FINDING] }) : review() }, { text: 'done' }];
  }
  if (r.system.includes('You are the finding verifier')) {
    const checks = text(r).includes('"F1"') || text(r).includes('\\"F1\\"') ? [{ id: 'F1', verdict: 'confirmed', confidence: 95, evidence: 'checked it' }] : [];
    return [{ tool: 'submit_output', input: { summary: 'Checked.', checks } }, { text: 'done' }];
  }
  return [{ text: 'ok' }];
}

describe.skipIf(!up)('PR conflict resolver with OpenCode', () => {
  let h: Harness;
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  let git: Awaited<ReturnType<typeof startFakeGit>>;
  let repo: ReturnType<typeof makeRepo>;
  let version: string;
  const saved = { AZHI_EGRESS_ALLOW: process.env.AZHI_EGRESS_ALLOW };

  const begin = async (pr: number) => (await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { repo: 'acme/shop', pr } })).run_id;
  const detail = (run: string) => h.api.get<any>(`/v1/runs/${run}`);
  const settle = async (run: string, node?: string) => {
    for (let i = 0; i < 2000; i++) {
      const d = await detail(run);
      if (node && d.run.flags?.waiting_reason?.node === node) return d;
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(d.run.state)) {
        if (node) throw new Error(`run ended ${d.run.state} before ${node}: ${JSON.stringify(d.run.error)}`);
        return d;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('the run did not settle');
  };
  const ok = (d: any, id: string) => d.attempts.find((a: any) => a.node_id === id && a.state === 'succeeded');

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'azhi-resolver-host-'));
    repo = makeRepo(root);
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    git = await startFakeGit(repo.srv, { token: READ_TOKEN });
    // Both sides name the repository: a head without one counts as a fork, which this workflow skips.
    const inRepo = { repo: { full_name: 'acme/shop' } };
    const pull = (number: number, ref: string, sha: string, file: string) => ({ number, title: `PR ${number}`, body: 'A change.', user: 'dev1', base: { ref: 'main', sha: repo.main, ...inRepo }, head: { ref, sha, ...inRepo }, mergeable: false, mergeable_state: 'dirty', files: [{ filename: file, status: 'modified', additions: 1, deletions: 1 }] });
    gh = await startFakeGithub({ runs: [], issues: [], pulls: [pull(7, 'feature', repo.feature, 'src/price.js'), pull(8, 'locks', repo.locks, 'package-lock.json')] }, { token: [READ_TOKEN, WRITE_TOKEN], refs: { main: { sha: repo.main, message: 'Adjust the price' } } });
    fake = await startFakeOpenAI({ script, models: [MODEL, STRONG, REFUTER] });
    h = await startHarness({ settings: { copilotApiUrl: `${fake.url}/v1`, copilotModel: MODEL } });
    await h.api.put('/v1/secrets/github-copilot-token', { value: COPILOT_TOKEN });
    await h.api.put('/v1/secrets/github-read-token', { value: READ_TOKEN });
    await h.api.put('/v1/secrets/github-write-token', { value: WRITE_TOKEN });
    const installed = await h.api.post<any>('/v1/examples/pr-conflict-resolver/install', { repos: ['acme/shop'], api_url: gh.url, git_url: git.url, settings: {} });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    // Publish the same package signed, with the checkouts on the local git host and a test command that passes.
    const dir = mkdtempSync(join(tmpdir(), 'azhi-resolver-'));
    cpSync(PKG, dir, { recursive: true });
    const wf = join(dir, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace(/^( *)credential: github-read-token\r?$/gm, `$1credential: github-read-token\n$1host: ${git.url}`).replace('command: npm ci && npm test', 'command: node -e 0'));
    const refuter = join(dir, 'profiles/conflict-refuter@1.yaml');
    writeFileSync(refuter, readFileSync(refuter, 'utf8').replace('gpt-5.6-terra', REFUTER));
    const res = await uploadDir(h.api, dir);
    expect(res.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(res.diagnostics.map((d: any) => d.code).filter((c: string) => c.startsWith('loop_'))).toEqual([]);
    version = res.version.id;
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await h?.stop();
    await fake?.close();
    await gh?.stop();
    await git?.stop();
  });

  it('a rejected first attempt gets a second on a stronger model, which continues from it, and the second is what ships', async () => {
    firstAttemptRejected = true;
    resolverFlagsInjection = false;
    const before = fake.requests.length;
    const run = await begin(7);
    const waiting = await settle(run, 'release_approval');

    // Both rounds ran, with the outcome each ended on.
    expect(waiting.loops).toHaveLength(1);
    expect(waiting.loops[0].outcome).toBe('done');
    expect(waiting.loops[0].rounds.map((r: any) => r.outcome)).toEqual(['retry', 'done']);

    // The override applied: round 1 on the default model, round 2 on the stronger one.
    const asked = fake.requests.slice(before);
    const resolvers = asked.filter((r) => r.system.includes('You are the merge resolver'));
    expect(new Set(resolvers.map((r) => r.model))).toEqual(new Set([MODEL, STRONG]));

    // Round 2 was told why, and started from round 1's files: the file it read holds round 1's text.
    const second = resolvers.filter((r) => r.model === STRONG);
    expect(text(second[0]!)).toContain('rejected_attempt');
    expect(text(second[0]!)).toContain('drops the raise');
    expect(second.map(text).join()).toContain('price = 125');
    const firstAsked = resolvers.filter((r) => r.model === MODEL);
    expect(text(firstAsked[0]!)).not.toContain('drops the raise');

    // Each round's agents have their own record.
    const manifests = new Set(waiting.context_manifests.map((m: any) => m.node_id));
    for (const id of ['attempt_1_resolve', 'attempt_2_resolve', 'attempt_1_review', 'attempt_2_review']) expect(manifests).toContain(id);

    // The approver sees the attempt that ships, not the first one.
    const ask = waiting.approvals.find((a: any) => a.node_id === 'release_approval').request;
    expect(ask.payload.diff).toContain('price = 130');
    expect(ask.payload.diff).not.toContain('price = 125');

    // Nothing was written before the approval.
    expect(gh.git.pulls).toHaveLength(0);
    await h.api.post(`/v1/runs/${run}/approvals`, { node: 'release_approval', decision: 'approved', data: {} });
    const done = await settle(run);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');

    // What was pushed is a merge of the base tip and the head, with the second attempt's files.
    const out = ok(done, 'finalize').output;
    expect(out).toMatchObject({ ship: true, attempt: 2 });
    expect(JSON.stringify(out.files ?? [])).toContain('price = 130');
    const branch = gh.git.refs.get(out.branch);
    expect(branch).toBeTruthy();
    expect(gh.git.commits.get(branch!)!.parents).toEqual([repo.main, repo.feature]);
    expect(gh.git.pulls).toHaveLength(1);
    expect(gh.git.pulls[0]).toMatchObject({ head: out.branch, base: 'feature' });
  }, 600_000);

  it('an accepted first attempt ends the loop: the second never runs', async () => {
    firstAttemptRejected = false;
    resolverFlagsInjection = false;
    const before = fake.requests.length;
    const run = await begin(7);
    const waiting = await settle(run, 'release_approval');
    expect(waiting.loops[0].outcome).toBe('done');
    expect(waiting.loops[0].rounds).toHaveLength(1);
    expect(ok(waiting, 'attempt_2_resolve')).toBeUndefined();
    expect(fake.requests.slice(before).some((r) => r.model === STRONG)).toBe(false);
    const ask = waiting.approvals.find((a: any) => a.node_id === 'release_approval').request;
    expect(ask.payload.diff).toContain('price = 125');
    await h.api.post(`/v1/runs/${run}/approvals`, { node: 'release_approval', decision: 'rejected', data: {} });
    await settle(run);
  }, 600_000);

  it('a reported injection stops the loop with no second attempt, and nothing is pushed', async () => {
    firstAttemptRejected = false;
    resolverFlagsInjection = true;
    const pulls = gh.git.pulls.length;
    const run = await begin(7);
    const done = await settle(run);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(done.loops[0].outcome).toBe('stop');
    expect(done.loops[0].rounds[0].reason).toContain('tried to instruct');
    expect(ok(done, 'attempt_2_resolve')).toBeUndefined();
    expect(ok(done, 'finalize').output.ship).toBe(false);
    expect(ok(done, 'release_approval')).toBeUndefined();
    expect(gh.git.pulls).toHaveLength(pulls);
    // A person is told, without the untrusted text. The tool updates the bot's own comment on the pull request.
    const told = gh.comments.find((c) => c.number === 7)!;
    expect(told.body).toContain('tried to instruct');
    expect(told.body).not.toContain('ignore your instructions');
    resolverFlagsInjection = false;
  }, 600_000);

  it('a conflict set aside for a person skips the loop, and finalize still says why', async () => {
    firstAttemptRejected = false;
    const comments = gh.comments.length;
    const run = await begin(8);
    const done = await settle(run);
    expect(done.run.error).toBeNull();
    expect(done.run.state).toBe('succeeded');
    expect(ok(done, 'attempt_1_resolve')).toBeUndefined();
    expect(ok(done, 'attempt')).toBeUndefined();
    expect(done.loops[0].rounds).toEqual([]);
    expect(ok(done, 'finalize').output).toMatchObject({ ship: false, attempt: 0 });
    expect(gh.comments.length).toBe(comments + 1);
    expect(gh.comments.at(-1)!.body).toContain('package-lock.json');
  }, 600_000);
});
