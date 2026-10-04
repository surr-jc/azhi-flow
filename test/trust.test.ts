import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startWorker } from '../src/worker/worker.js';
import { startHarness, temporalAvailable, TEMPORAL, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

const up = await temporalAvailable();

/** Identical packages share a content hash and therefore a version; each case needs its own. */
function examplePackage(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-pkg-'));
  cpSync('examples/ci-digest', dir, { recursive: true });
  writeFileSync(join(dir, 'NOTE.md'), `${tag}\n`);
  return dir;
}

describe.skipIf(!up)('package signing and worker trust policies', () => {
  let h: Harness;
  let other: ApiClient;
  beforeAll(async () => {
    h = await startHarness();
    const config = parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8'));
    for (const t of config.tools) await h.api.post('/v1/tools', t);
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'second author', role: 'author' });
    other = new ApiClient(h.server.url, u.token);
  });
  afterAll(async () => h?.stop());

  it('plans the owner\'s own package with every requirement met', async () => {
    const pkg = await uploadDir(h.api, examplePackage('own'));
    const plan = await h.api.get<any>(`/v1/versions/${pkg.version.id}/plan`);
    expect(plan.blockers).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.signer.verified).toBe(true);
    const metrics = plan.nodes.find((n: any) => n.id === 'metrics');
    expect(metrics.requirements.map((r: any) => [r.name, r.mark])).toContainEqual(['worker trust policy accepts the package signer', 'native']);
    expect(metrics.coverage.map((c: any) => c.enforcement)).toContain('unobservable');
  });

  it('refuses another author\'s package at plan time when the worker trusts only itself', async () => {
    const pkg = await uploadDir(other, examplePackage('other-self'), { keyDir: mkdtempSync(join(tmpdir(), 'azhi-keys-')) });
    const plan = await h.api.get<any>(`/v1/versions/${pkg.version.id}/plan`);
    expect(plan.ok).toBe(false);
    expect(plan.blockers.map((b: any) => b.code)).toContain('worker_trust_denied');
    await expect(h.api.post('/v1/runs', { version: pkg.version.id, inputs: { team: 'payments' } })).rejects.toThrow(/worker_trust_denied|no capable worker/);
  });

  it('runs that package on a worker that trusts workspace publishers', async () => {
    const pkg = await uploadDir(other, examplePackage('other-publishers'), { keyDir: mkdtempSync(join(tmpdir(), 'azhi-keys-')) });
    await h.worker!.stop();
    const token = readFileSync(h.server.localTokenFile!, 'utf8').trim();
    const w = await startWorker({ apiUrl: h.server.url, token, temporalAddress: TEMPORAL, dataDir: join(h.dataDir, 'worker2'), trustPolicy: { kind: 'workspace-publishers' }, log: () => {} });
    try {
      const plan = await h.api.get<any>(`/v1/versions/${pkg.version.id}/plan`);
      expect(plan.blockers).toEqual([]);
      const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: pkg.version.id, inputs: { team: 'payments' } });
      const d = await waitForRun(h.api, run_id);
      expect(d.run.error).toBeNull();
      expect(d.run.state).toBe('succeeded');
    } finally {
      await w.stop();
    }
  });

  it('refuses an unsigned package', async () => {
    const pkg = await uploadDir(h.api, examplePackage('unsigned'), { sign: false });
    const plan = await h.api.get<any>(`/v1/versions/${pkg.version.id}/plan`);
    expect(plan.signer.verified).toBe(false);
    expect(plan.ok).toBe(false);
  });
});
