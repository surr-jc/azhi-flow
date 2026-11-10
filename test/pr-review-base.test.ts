import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { staticCatalog } from '../src/gateway/types.js';
import { startFakeGit } from '../src/testing/fake-git.js';
import { cloneWorkspace } from '../src/worker/workspace.js';

/**
 * PR review against a merged pull request: its base branch already contains the PR commits, so the
 * workspace fetches the base commit GitHub recorded (base_sha) instead, refuses a head the base
 * already contains, and repo-facts reports an empty diff as an error rather than "(no changes)".
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const REPO_FACTS = resolve('examples/pr-review/harness/mcp/repo-facts.mjs');

/** Calls one repo-facts tool in `dir` over stdio and returns the MCP result. */
function repoFacts(dir: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [REPO_FACTS], { env: { PATH: process.env.PATH, AZHI_WORKSPACE: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (b) => {
      out += b;
      const line = out.split('\n').find((l) => l.includes('"id":2'));
      if (line) {
        p.kill();
        done(JSON.parse(line).result);
      }
    });
    p.on('error', fail);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

describe.skipIf(!hasGit)('pr-review base of a merged pull request', () => {
  const root = mkdtempSync(join(tmpdir(), 'azhi-pr-base-'));
  let git: Awaited<ReturnType<typeof startFakeGit>>;
  let baseSha = '';
  let stackBase = '';
  let n = 0;

  beforeAll(async () => {
    const work = join(root, 'work');
    mkdirSync(join(work, 'src'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'd@example.com' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: work, env }).toString().trim();
    g('init', '-q', '-b', 'release', '.');
    writeFileSync(join(work, 'src/repo.java'), 'status == DONE\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    baseSha = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'feature');
    writeFileSync(join(work, 'src/repo.java'), 'status == DONE || status == FAILED\n');
    g('commit', '-qam', 'treat FAILED as terminal');
    // Merged with a merge commit: the release branch now contains the PR head.
    g('checkout', '-q', 'release');
    g('merge', '-q', '--no-ff', '-m', 'Merge pull request #664', 'feature');
    // A stacked pull request: its branch holds an earlier story's commit, then its own.
    g('checkout', '-qb', 'stacked', baseSha);
    writeFileSync(join(work, 'src/one.txt'), 'story one\n');
    g('add', '.');
    g('commit', '-qm', 'story one');
    stackBase = g('rev-parse', 'HEAD');
    writeFileSync(join(work, 'src/two.txt'), 'story two\n');
    g('add', '.');
    g('commit', '-qm', 'story two');
    g('checkout', '-q', 'release');
    mkdirSync(join(root, 'srv/acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'srv/acme/app.git')], { env });
    execFileSync('git', ['-C', join(root, 'srv/acme/app.git'), 'update-ref', 'refs/pull/664/head', 'refs/heads/feature'], { env });
    execFileSync('git', ['-C', join(root, 'srv/acme/app.git'), 'update-ref', 'refs/pull/665/head', 'refs/heads/stacked'], { env });
    git = await startFakeGit(join(root, 'srv'), { token: 'ghp_read' });
  });
  afterAll(async () => {
    await git?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const clone = (baseRef?: string, ref = 'refs/pull/664/head') => {
    const step = join(root, `step${++n}`);
    const home = join(step, 'home');
    mkdirSync(home, { recursive: true });
    return cloneWorkspace({ host: git.url, repo: 'acme/app', ref, ...(baseRef ? { baseRef } : {}) }, { root: step, home, token: 'ghp_read', timeoutMs: 30_000 });
  };

  it('diffs the merged pull request against its recorded base commit', async () => {
    const c = await clone(baseSha);
    expect(c.base).toBe(baseSha);
    const files = await repoFacts(c.dir, 'changed-files');
    expect(files.isError).toBeFalsy();
    expect(files.content[0]!.text).toBe('M\tsrc/repo.java');
    const diff = await repoFacts(c.dir, 'file-diff', { path: 'src/repo.java' });
    expect(diff.content[0]!.text).toContain('+status == DONE || status == FAILED');
  });

  it('refuses a head that the live base branch already contains', async () => {
    await expect(clone('refs/heads/release')).rejects.toThrow(/already contained in base_ref refs\/heads\/release.*merged/);
  });

  it('makes repo-facts report a missing base as an error, not "(no changes)"', async () => {
    const c = await clone();
    for (const [name, args] of [['changed-files', {}], ['file-diff', { path: 'src/repo.java' }]] as const) {
      const r = await repoFacts(c.dir, name, args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('refs/azhi/base is missing');
    }
  });

  it('gates every reviewer on an open pull request and fetches the base by SHA', () => {
    const pkg = packageFromDirectory('examples/pr-review');
    const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!;
    const r = compile(def, { pkg, catalog: staticCatalog(parse(readFileSync('examples/pr-review/azhi.config.yaml', 'utf8')).tools) });
    expect(r.ok).toBe(true);
    for (const id of ['correctness', 'security', 'tests', 'quality']) expect(r.plan!.nodes.find((x) => x.id === id)!.route).toEqual({ condition: 'should_review', route: 'review' });
    const gate = def.nodes.find((x) => x.id === 'should_review') as { expression: string };
    expect(gate.expression).toContain("nodes.pr.output.state == 'open'");
    // The recorded base, unless the run names the commit a stacked pull request's own work starts from.
    expect((def.nodes.find((x) => x.id === 'security') as { workspace: { base_ref: unknown } }).workspace.base_ref).toEqual({ cel: "has(inputs.diff_base) && inputs.diff_base != '' ? inputs.diff_base : nodes.pr.output.base_sha" });
    const diffBase = (def.inputs as { properties: Record<string, { pattern?: string }> }).properties.diff_base!;
    for (const [value, ok] of [['', true], ['a'.repeat(40), true], ['a'.repeat(64), true], ['main', false], ['refs/heads/x', false], ['a'.repeat(39), false]] as const) {
      expect(new RegExp(diffBase.pattern!).test(value), value).toBe(ok);
    }
  });

  it('reviews a stacked pull request from the commit its own work starts at', async () => {
    // Against the base branch the diff holds the earlier story too; against diff_base, only this one.
    const whole = await repoFacts((await clone(baseSha, 'refs/pull/665/head')).dir, 'changed-files');
    expect(whole.content[0]!.text.split('\n').sort()).toEqual(['A\tsrc/one.txt', 'A\tsrc/two.txt']);
    const own = await clone(stackBase, 'refs/pull/665/head');
    expect(own.base).toBe(stackBase);
    const files = await repoFacts(own.dir, 'changed-files');
    expect(files.isError).toBeFalsy();
    expect(files.content[0]!.text).toBe('A\tsrc/two.txt');
  });
});
