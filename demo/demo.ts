/**
 * The alpha exit demo (spec section 13): six pass/fail checks, run live with real processes.
 *
 *   npm run demo                 # checks 2 to 6 against the PostgreSQL and Temporal in the env
 *   npm run demo -- --install    # also check 1: a fresh deploy/install.sh, timed
 *
 * The server, the gateway and the worker run as separate `azhi` processes started from this
 * checkout, exactly as `azhi server start` and `azhi worker start` run them, so the gateway can
 * be killed mid-post. Slack is the bundled fake (no workspace needed). The analyst calls a real
 * Anthropic model when ANTHROPIC_API_KEY and AZHI_ANTHROPIC_MODEL are set; otherwise it calls a
 * scripted Anthropic-compatible endpoint, and the demo says so.
 *
 * Environment: AZHI_DEMO_DATABASE_URL (admin connection; a fresh database is created per demo,
 * default postgres://azhi:azhi@localhost:5432/azhi) and AZHI_TEMPORAL_ADDRESS (localhost:7233).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { parse } from 'yaml';
import { startFakeAnthropic } from '../src/testing/fake-anthropic.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';
import { ApiClient } from '../src/worker/api-client.js';

const ROOT = resolve(import.meta.dirname, '..');
const PKG = join(ROOT, 'examples/quality-report');
const ADMIN_DB = process.env.AZHI_DEMO_DATABASE_URL ?? 'postgres://azhi:azhi@localhost:5432/azhi';
const TEMPORAL = process.env.AZHI_TEMPORAL_ADDRESS ?? 'localhost:7233';
const TERMINAL = ['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'];

const work = mkdtempSync(join(tmpdir(), 'azhi-demo-'));
const logs = join(work, 'logs');
mkdirSync(logs);
const children: ChildProcess[] = [];
const results: Array<{ n: number; title: string; pass: boolean | null; evidence: string[] }> = [];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

function proc(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const c = spawn(process.execPath, [join(ROOT, 'bin/azhi.js'), ...args], { env, cwd: ROOT });
  const out = createWriteStream(join(logs, `${name}.log`), { flags: 'a' });
  c.stdout?.pipe(out);
  c.stderr?.pipe(out);
  children.push(c);
  return c;
}

/** Runs the CLI the way a person would and returns what it printed. */
async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  const c = spawn(process.execPath, [join(ROOT, 'bin/azhi.js'), ...args], { env, cwd: ROOT });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number>((r) => c.on('exit', (x) => r(x ?? 1)));
  return { code, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
}

async function check(n: number, title: string, body: (evidence: string[]) => Promise<boolean | null>) {
  console.log(`\n${bold(`Check ${n}. ${title}`)}`);
  const evidence: string[] = [];
  const t0 = Date.now();
  let pass: boolean | null;
  try {
    pass = await body(evidence);
  } catch (err) {
    evidence.push(`error: ${(err as Error).message}`);
    pass = false;
  }
  for (const e of evidence) console.log(`  ${e}`);
  console.log(`  ${pass === null ? 'SKIPPED' : pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  results.push({ n, title, pass, evidence });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const runDone = (api: ApiClient, id: string, timeoutMs = 180_000) =>
  waitFor(`run ${id}`, async () => {
    const d = await api.get<any>(`/v1/runs/${id}`);
    return TERMINAL.includes(d.run.state) ? d : undefined;
  }, timeoutMs);

async function main() {
  const install = process.argv.includes('--install');
  const realModel = Boolean(process.env.ANTHROPIC_API_KEY && process.env.AZHI_ANTHROPIC_MODEL);

  // ---- Check 1 ---------------------------------------------------------------------------------
  await check(1, 'Fresh install of server plus one worker in under 15 minutes', async (ev) => {
    if (!install) {
      ev.push('not run: pass --install to time deploy/install.sh on this host (see docs/install.md)');
      return null;
    }
    const t0 = Date.now();
    const project = `azhi-demo-${Date.now().toString(36)}`;
    const port = await freePort();
    const c = spawn('bash', [join(ROOT, 'deploy/install.sh')], {
      env: { ...process.env, AZHI_COMPOSE_PROJECT: project, AZHI_PORT: String(port), AZHI_PG_PORT: String(await freePort()), AZHI_TEMPORAL_PORT: String(await freePort()) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout!.on('data', (d) => (out += d));
    c.stderr!.on('data', (d) => (out += d));
    const code = await new Promise<number>((r) => c.on('exit', (x) => r(x ?? 1)));
    writeFileSync(join(logs, 'install.log'), out);
    const secs = Math.round((Date.now() - t0) / 1000);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
    ev.push(`deploy/install.sh exited ${code} after ${secs} s; /healthz ${health ? 'ok' : 'not reachable'} (compose project ${project}, left running)`);
    ev.push(out.split('\n').find((l) => l.startsWith('Azhi Flow is up')) ?? '');
    return code === 0 && health && secs < 900;
  });

  // ---- Platform for checks 2 to 6 ----------------------------------------------------------------
  const slack = await startFakeSlack();
  const anthropic = realModel
    ? undefined
    : await startFakeAnthropic({
        script: [
          {
            tool: 'submit_output',
            input: {
              headline: 'Pass rate fell 10 points to 85.0%; most failures were the flaky checkout test.',
              points: [
                { text: 'Two of three failures were test_checkout_timeout, which is flaky and not quarantined yet.', citations: ['{{chunk:0}}'] },
                { text: 'Mean time to green rose by 4.0 h.', citations: ['{{chunk:1}}'] },
              ],
              insufficient_evidence: false,
            },
          },
          { text: 'done' },
        ],
      });

  const dbName = `azhi_demo_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(ADMIN_DB);
  dbUrl.pathname = `/${dbName}`;

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const home = join(work, 'home');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AZHI_DATABASE_URL: dbUrl.toString(),
    AZHI_TEMPORAL_ADDRESS: TEMPORAL,
    AZHI_DATA_DIR: join(work, 'server'),
    AZHI_PORT: String(port),
    AZHI_URL: url,
    AZHI_SLACK_API_URL: slack.url,
    AZHI_GATEWAY_QUEUE: `azhi-gateway-${dbName}`,
    AZHI_INTERPRETER_BUILD: `demo${Date.now().toString(36)}`,
    ...(anthropic ? { AZHI_ANTHROPIC_API_URL: anthropic.url, AZHI_ANTHROPIC_MODEL: 'scripted-demo-model' } : {}),
  };
  delete env.AZHI_FAULT;
  proc('server', ['server', 'start', '--roles', 'api,interpreter,scheduler'], env);
  let gateway = proc('gateway', ['server', 'start', '--roles', 'gateway'], env);
  await waitFor('the server', async () => ((await fetch(`${url}/healthz`)).ok ? true : undefined), 60_000);
  const token = readFileSync(join(work, 'server/local-token'), 'utf8').trim();
  const api = new ApiClient(url, token);
  const as = (t: string) => ({ ...env, AZHI_TOKEN: t });
  const azhi = (args: string[], t = token) => cli(['--token', t, ...args], as(t));
  proc('worker', ['--token', token, 'worker', 'start', '--name', 'demo-worker'], env);
  await waitFor('the worker', async () => ((await api.get<any[]>("/v1/workers")).some((w) => w.online) ? true : undefined), 60_000);

  const config = parse(readFileSync(join(PKG, 'azhi.config.yaml'), 'utf8'));
  for (const t of config.tools) await api.post('/v1/tools', t);
  await api.put('/v1/secrets/slack-bot-token', { value: 'xoxb-demo' });
  await api.put('/v1/secrets/anthropic-api-key', { value: process.env.ANTHROPIC_API_KEY ?? 'sk-demo-scripted' });
  await azhi(['dataset', 'create', 'quality-guidelines']);
  await azhi(['dataset', 'add', 'quality-guidelines', join(PKG, 'knowledge')]);
  await azhi(['dataset', 'publish', 'quality-guidelines', '--tag', 'approved']);
  console.log(`\nplatform: server ${url}, gateway and worker as separate processes, logs in ${logs}`);
  console.log(`model: ${realModel ? `Anthropic ${process.env.AZHI_ANTHROPIC_MODEL}` : 'scripted Anthropic-compatible endpoint (set ANTHROPIC_API_KEY and AZHI_ANTHROPIC_MODEL for a real model)'}`);

  // ---- Check 2 ---------------------------------------------------------------------------------
  await check(2, '`azhi plan` shows capabilities, coverage and taint paths; an ungated tainted write is rejected', async (ev) => {
    const plan = await azhi(['plan', PKG]);
    writeFileSync(join(work, 'plan.txt'), plan.out);
    const has = (s: RegExp) => s.test(plan.out);
    ev.push(`azhi plan exited ${plan.code}; full output in ${join(work, 'plan.txt')}`);
    for (const l of plan.out.split('\n').filter((l) => /taint|analyse|post|enforced|harness|unobservable/i.test(l)).slice(0, 8)) ev.push(`  | ${l.trim()}`);
    const ungated = mkdtempSync(join(work, 'ungated-'));
    cpSync(PKG, ungated, { recursive: true });
    const wf = join(ungated, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace(/\n\s*#[^\n]*ADR-10[^\n]*\n[^\n]*\n\s*guard:[^\n]*/, '\n'));
    const rejected = await azhi(['plan', ungated]);
    const diag = rejected.out.split('\n').find((l) => l.includes('tainted_write_ungated')) ?? rejected.out.trim().split('\n')[0];
    ev.push(`without the guard: exit ${rejected.code}: ${diag?.trim()}`);
    return plan.code === 0 && has(/enforced/) && has(/taint/i) && rejected.code !== 0 && rejected.out.includes('tainted_write_ungated');
  });

  // ---- Check 3 ---------------------------------------------------------------------------------
  await check(3, 'The scheduled run completes with no client attached; Slack gets citations and as-of times', async (ev) => {
    const pub = await azhi(['publish', PKG]);
    ev.push(pub.out.trim());
    const sched = await azhi(['schedule', 'quality-report', '--cron', '* * * * *', '--timezone', 'UTC', '-i', 'team=payments']);
    ev.push(`${sched.out.trim()} (every minute for the demo; the package says Mondays 08:00)`);
    ev.push('no CLI or browser is attached; waiting for the message to reach Slack');
    const before = slack.messages.length;
    const msg = await waitFor('the scheduled post', async () => slack.messages[before], 150_000);
    await azhi(['schedule', 'quality-report', '--cron', '* * * * *', '--timezone', 'UTC', '--disable']);
    const run = (await api.get<any[]>('/v1/runs?limit=20')).find((r) => r.trigger === 'schedule' && r.workflow === 'quality-report');
    const d = run ? await runDone(api, run.id) : undefined;
    for (const l of msg.text.split('\n').filter(Boolean)) ev.push(`  slack | ${l}`);
    ev.push(`run ${run?.id}: ${d?.run.state}, trigger ${run?.trigger}`);
    const asOf = ['ci', 'flaky-tests', 'incidents'].every((s) => new RegExp(`${s} data as of \\d{4}-`).test(msg.text));
    return d?.run.state === 'succeeded' && /\[1\]/.test(msg.text) && /quality-guidelines@\d+/.test(msg.text) && asOf;
  });

  // ---- Check 4 ---------------------------------------------------------------------------------
  await check(4, 'The process posting to Slack is killed mid-post; recovery sends exactly one message', async (ev) => {
    ev.push('the Slack post runs in the gateway, so the gateway is the process killed (after the send, before the receipt)');
    gateway.kill('SIGTERM');
    await new Promise((r) => gateway.on('exit', r));
    const crashing = proc('gateway-crash', ['server', 'start', '--roles', 'gateway'], { ...env, AZHI_FAULT: 'ledger.sent' });
    const killed = new Promise<string | null>((r) => crashing.on('exit', (_c, s) => r(s)));
    const before = slack.messages.length;
    const run = await azhi(['run', PKG, '-i', 'team=checkout']);
    const runId = run.out.match(/run_[0-9a-z]+/)?.[0];
    if (!runId) throw new Error(`could not start the run: ${run.out}`);
    ev.push(`started ${runId}; gateway exited with ${await killed}; messages in Slack so far: ${slack.messages.length - before}`);
    gateway = proc('gateway', ['server', 'start', '--roles', 'gateway'], env);
    const d = await runDone(api, runId);
    const sent = slack.messages.length - before;
    const action = d.actions[0];
    ev.push(`run ${d.run.state}; Slack messages for this run: ${sent}`);
    ev.push(`ledger ${action?.id}: ${action?.transitions.map((t: any) => `${t.state}${t.note ? ` (${t.note})` : ''}`).join(' → ')}`);
    return d.run.state === 'succeeded' && sent === 1 && d.actions.length === 1 && action.state === 'confirmed' && action.transitions.some((t: any) => t.state === 'outcome_unknown');
  });

  // ---- Check 5 ---------------------------------------------------------------------------------
  await check(5, "A worker with the `self` trust policy refuses another author's package at plan time", async (ev) => {
    const user = await azhi(['user', 'add', 'second-author', '--role', 'author']);
    const other = user.out.match(/azhi_[A-Za-z0-9_-]+/)?.[0];
    if (!other) throw new Error(`could not create the second author: ${user.out}`);
    const copy = mkdtempSync(join(work, 'other-'));
    cpSync(PKG, copy, { recursive: true });
    writeFileSync(join(copy, 'NOTE.md'), 'Uploaded and signed by a second author.\n');
    const plan = await azhi(['plan', copy], other);
    for (const l of plan.out.split('\n').filter((l) => /trust|blocker|signed|signer/i.test(l)).slice(0, 6)) ev.push(`  | ${l.trim()}`);
    const run = await azhi(['run', copy, '-i', 'team=payments'], other);
    ev.push(`azhi run as the second author: exit ${run.code}: ${run.out.trim().split('\n').at(-1)}`);
    return plan.out.includes('worker_trust_denied') && run.code !== 0;
  });

  // ---- Check 6 ---------------------------------------------------------------------------------
  await check(6, 'The same 30 fixtures through the model agent and OpenCode', async (ev) => {
    const out = join(work, 'executor-comparison.md');
    const c = spawn('npx', ['tsx', 'bench/compare.ts', '--out', out], { cwd: ROOT, env: { ...process.env, AZHI_TEST_DATABASE_URL: ADMIN_DB, AZHI_TEMPORAL_ADDRESS: TEMPORAL } });
    let log = '';
    c.stdout.on('data', (d) => (log += d));
    c.stderr.on('data', (d) => (log += d));
    const code = await new Promise<number>((r) => c.on('exit', (x) => r(x ?? 1)));
    writeFileSync(join(logs, 'compare.log'), log);
    if (!existsSync(out)) throw new Error(`comparison produced no report (exit ${code}); see ${join(logs, 'compare.log')}`);
    const md = readFileSync(out, 'utf8');
    for (const l of md.split('\n').filter((l) => /^\| (Contract success|Median|Total cost|Runs with complete|Runs offered|\| agent)/.test(l) || l.startsWith('| |'))) ev.push(`  ${l}`);
    ev.push(`report: ${out}`);
    const row = md.split('\n').find((l) => l.startsWith('| Contract success')) ?? '';
    return code === 0 && /\| 30 \/ 30 \| 30 \/ 30 \|/.test(row) && md.includes('## Ambient tools');
  });

  // ---- Summary ---------------------------------------------------------------------------------
  console.log(`\n${bold('Summary')}`);
  for (const r of results) console.log(`  ${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.n}. ${r.title}`);
  writeFileSync(join(work, 'demo-results.json'), JSON.stringify({ at: new Date().toISOString(), real_model: realModel, results }, null, 2));
  console.log(`\nresults: ${join(work, 'demo-results.json')}`);
  await slack.close();
  await anthropic?.close();
  return results.every((r) => r.pass !== false);
}

main()
  .then((ok) => (process.exitCode = ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(), 3000).unref();
  });
