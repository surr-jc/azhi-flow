import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { harnessPrepare, type AgentBeginInput, type WorkspaceFrom } from '../src/agents/model-agent.js';
import { fsArtifactStore } from '../src/artifacts/store.js';
import { migrate } from '../src/db/migrate.js';
import { sha256 } from '../src/lib/hash.js';
import { createContext, type AppContext } from '../src/server/context.js';
import { stagePackage } from '../src/server/packages.js';
import { validateContinuation } from '../src/worker/continuation.js';

/**
 * The server side of workspace.from: the change is read from the producing step's stored output (inline or
 * artifacted), checked, kept as a small artifact for the worker, and described to the agent. No Temporal here.
 */
const WS = 'ws-from';
const RUN = 'run-from';
const BASE = 'b'.repeat(40);
const PROFILE = 'model: {provider: anthropic, name: claude-test-model}\ninstructions: Review the change.\n';

const file = (path: string, over: Record<string, unknown> = {}) => ({ path, status: 'added', mode: '100644', content: `// ${path}\n`, encoding: 'utf-8', additions: 1, deletions: 0, ...over });
const changeOf = (files = [file('src/a.js'), file('src/b.js')], over: Record<string, unknown> = {}) => ({
  repo: 'acme/shop',
  ref: 'HEAD',
  base_sha: BASE,
  files,
  diff: 'x'.repeat(5000),
  diff_truncated: false,
  stats: { files: files.length, additions: files.length, deletions: 0 },
  tests: { status: 'passed', command: 'npm test', exit_code: 0, attempts: 1, output: 'ok' },
  ...over,
});

describe('workspace.from on the server', () => {
  let ctx: AppContext;
  let hash: string;

  const attempt = (node: string, state: string, output: unknown, n = 1) =>
    ctx.pool.query(`INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, output) VALUES ($1,$2,$3,$4,$5,$6)`, [WS, RUN, node, n, state, output === undefined ? null : JSON.stringify(output)]);

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'azhi-from-'));
    ctx = createContext({ databaseUrl: 'pglite://memory', dataDir, artifactDir: join(dataDir, 'artifacts') });
    ctx.artifacts = fsArtifactStore(join(dataDir, 'artifacts'));
    await migrate(ctx.pool);
    // Test setup only: the rows below stand for a finished run without building the workflow, version and run around them.
    await ctx.pool.query(`SET session_replication_role = replica`);
    hash = `sha256:${sha256(`from-${Math.random()}`)}`;
    const bytes = Buffer.from(PROFILE);
    stagePackage(ctx, WS, hash, { format: 'azhi-package/1', workflow: 'workflow.yaml', files: [{ path: 'profiles/reviewer@1.yaml', sha256: sha256(bytes), size: bytes.length }] }, new Map([['profiles/reviewer@1.yaml', bytes]]));
    await attempt('build', 'succeeded', { summary: 's', workspace: changeOf() });
    // A large output is stored as an artifact handle, not inline.
    const big = ctx.artifacts.put(JSON.stringify({ summary: 's', workspace: changeOf([file('big/x.js', { content: 'y'.repeat(200_000) })]) }));
    await ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,'application/json')`, [WS, big.hash, big.size]);
    await attempt('big', 'succeeded', { $artifact: { hash: big.hash, size: big.size, media_type: 'application/json' } });
    await attempt('skipped', 'skipped', null);
    await attempt('retried', 'succeeded', { workspace: changeOf([file('old.js')]) }, 1);
    await attempt('retried', 'succeeded', { workspace: changeOf([file('new.js')]) }, 2);
    await attempt('selector', 'succeeded', changeOf([file('sel.js')]));
    await attempt('text', 'succeeded', { summary: 'no change here' });
    await attempt('otherrepo', 'succeeded', { workspace: changeOf([file('a.js')], { repo: 'acme/other' }) });
  });

  const prepare = (from: WorkspaceFrom | undefined, mode: 'read' | 'write' = 'read', repo = 'acme/shop') => {
    const i: AgentBeginInput & { workspace?: { repo: string; ref: string; mode: 'read' | 'write' }; workspaceFrom?: WorkspaceFrom } = {
      runId: RUN,
      workspaceId: WS,
      nodeId: 'review',
      packageHash: hash,
      profile: 'reviewer@1',
      outputSchema: { type: 'object' },
      tools: [],
      input: { ticket: 't' },
      inputSources: [],
      workspace: { repo, ref: 'HEAD', mode },
      ...(from ? { workspaceFrom: from } : {}),
    };
    return harnessPrepare(ctx, i, 'opencode');
  };
  const fetched = (artifact: string) => JSON.parse(ctx.artifacts.get(artifact)!.toString('utf8'));

  it('reads an inline output, keeps only base_sha and files as an artifact, and registers it for the worker', async () => {
    const r = await prepare({ ref: 'nodes.build.output.workspace' });
    expect(r.continuation).toEqual({ artifact: expect.stringMatching(/^sha256:/), baseSha: BASE, files: 2 });
    const body = fetched(r.continuation!.artifact);
    expect(Object.keys(body).sort()).toEqual(['baseSha', 'files']);
    expect(body.files.map((f: any) => f.path)).toEqual(['src/a.js', 'src/b.js']);
    expect(body.files[0]).toMatchObject({ status: 'added', mode: '100644', content: '// src/a.js\n', encoding: 'utf-8' });
    // The diff, stats and test output stay out: the worker needs the files and the base, nothing else.
    expect(JSON.stringify(body)).not.toContain('xxxx');
    // The worker fetches it by hash with its run token, which needs the artifacts row.
    const row = await ctx.pool.query(`SELECT media_type FROM artifacts WHERE workspace_id=$1 AND hash=$2`, [WS, r.continuation!.artifact]);
    expect(row.rowCount).toBe(1);
    // What the artifact holds passes the worker's own checks.
    expect(() => validateContinuation(body)).not.toThrow();
  });

  it('reads an artifacted output, and the latest successful attempt', async () => {
    const big = await prepare({ ref: 'nodes.big.output.workspace' });
    expect(fetched(big.continuation!.artifact).files[0].content.length).toBe(200_000);
    // The activity result is small whatever the change weighs: that is what reaches workflow history.
    expect(JSON.stringify(big.continuation).length).toBeLessThan(300);
    expect(big.prompt).not.toContain('yyyy');
    const retried = await prepare({ ref: 'nodes.retried.output.workspace' });
    expect(fetched(retried.continuation!.artifact).files.map((f: any) => f.path)).toEqual(['new.js']);
  });

  it('accepts a producer that is not a write-mode agent (a selector script)', async () => {
    const r = await prepare({ ref: 'nodes.selector.output' });
    expect(r.continuation).toMatchObject({ baseSha: BASE, files: 1 });
  });

  it('tells a read-mode agent where the diff is, and a write-mode agent to build on the change', async () => {
    const read = await prepare({ ref: 'nodes.build.output.workspace' }, 'read');
    expect(read.prompt).toContain('Your checkout contains the change made by step build (2 files');
    expect(read.prompt).toContain('a diff against refs/azhi/base shows them');
    const write = await prepare({ ref: 'nodes.build.output.workspace' }, 'write');
    expect(write.prompt).toContain('Your checkout already contains the change made by step build');
    expect(write.prompt).toContain('Build on it; do not apply it again.');
  });

  it('lists file names as quoted, shortened data, and not all of them', async () => {
    const many = Array.from({ length: 15 }, (_, i) => file(i === 0 ? `${'long/'.repeat(40)}x.js` : `f${i}.js`));
    await attempt('many', 'succeeded', { workspace: changeOf(many) });
    const r = await prepare({ ref: 'nodes.many.output.workspace' });
    expect(r.prompt).toContain('names given as data: ["long/long/');
    expect(r.prompt).toContain('...');
    expect(r.prompt).toContain('and 3 more');
    expect(r.prompt).not.toContain('f14.js');
  });

  it('records the continuation in the context manifest, with a hash and no content', async () => {
    await prepare({ ref: 'nodes.build.output.workspace' });
    const m = (await ctx.pool.query(`SELECT items FROM context_manifests WHERE run_id=$1 AND node_id='review' ORDER BY turn DESC LIMIT 1`, [RUN])).rows[0].items as Array<Record<string, any>>;
    const it = m.find((x) => x.source === 'workspace continuation from nodes.build')!;
    expect(it).toMatchObject({ kind: 'input', tokens: 0, content_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(it.content).toBeUndefined();
  });

  it('fails loudly, with the producer named, when there is nothing to continue from', async () => {
    await expect(prepare({ ref: 'nodes.skipped.output.workspace' })).rejects.toThrow(/step 'skipped' has no output in this run/);
    await expect(prepare({ ref: 'nodes.nope.output.workspace' })).rejects.toThrow(/step 'nope' has no output/);
    await expect(prepare({ ref: 'nodes.text.output.workspace' })).rejects.toThrow(/not a workspace change/);
    await expect(prepare({ ref: 'nodes.text.output' })).rejects.toThrow(/not a workspace change/);
    await expect(prepare({ ref: 'inputs.change' })).rejects.toThrow(/not a ref to a step's output/);
  });

  it('refuses a change for another repository', async () => {
    await expect(prepare({ ref: 'nodes.otherrepo.output.workspace' })).rejects.toThrow(/is for acme\/other, but this step works in acme\/shop/);
    await expect(prepare({ ref: 'nodes.build.output.workspace' }, 'read', 'Acme/Shop')).resolves.toBeTruthy(); // names compare without case
  });

  it('takes the value itself for a test run, which has only fixtures', async () => {
    const r = await prepare({ value: changeOf([file('fixture.js')]), producer: 'build' });
    expect(r.continuation).toMatchObject({ baseSha: BASE, files: 1 });
    expect(r.prompt).toContain('step build');
    await expect(prepare({ value: { nothing: true }, producer: 'build' })).rejects.toThrow(/not a workspace change/);
  });

  it('adds nothing when the step does not continue from anything', async () => {
    const r = await prepare(undefined);
    expect(r.continuation).toBeUndefined();
    expect(r.prompt).not.toContain('checkout');
  });
});
