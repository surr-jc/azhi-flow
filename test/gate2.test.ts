import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, type Harness } from './helpers/harness.js';

/**
 * Gate 2 (implementation plan): `azhi plan` on the draft quality-report package shows
 * capabilities, coverage and taint paths (golden file); an ungated write after a tainted node
 * is rejected; a `self` worker refuses another author's package at plan time.
 */
const up = await temporalAvailable();
const PKG = 'examples/quality-report';
const GOLDEN = 'test/golden/quality-report.plan.json';

function copyPackage(edit?: (wf: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'azhi-qr-'));
  cpSync(PKG, dir, { recursive: true });
  if (edit) writeFileSync(join(dir, 'workflow.yaml'), edit(readFileSync(join(dir, 'workflow.yaml'), 'utf8')));
  return dir;
}

/** Replaces values that differ per machine and per run so the plan can be compared. */
function normalise(plan: any): unknown {
  let text = JSON.stringify(plan);
  const swap = (value: string | undefined, label: string) => {
    if (value) text = text.split(value).join(label);
  };
  swap(plan.package_hash, '<package-hash>');
  swap(plan.signer.publisher, '<publisher>');
  for (const w of plan.worker_trust) {
    swap(w.worker, '<worker-id>');
    swap(w.name, '<worker>');
  }
  text = text.replace(/python \d+\.\d+\.\d+/g, 'python <version>');
  return JSON.parse(text);
}

describe.skipIf(!up)('Gate 2: run plan, taint rule and worker trust', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ settings: { anthropicModel: 'server-default-model' } });
    for (const t of parse(readFileSync(`${PKG}/azhi.config.yaml`, 'utf8')).tools) await h.api.post('/v1/tools', t);
    await h.api.post('/v1/datasets', { name: 'quality-guidelines' });
    await h.api.post('/v1/datasets/quality-guidelines/documents', { documents: [{ path: 'quality-guidelines.md', content: readFileSync(`${PKG}/knowledge/quality-guidelines.md`, 'utf8') }] });
    await h.api.post('/v1/datasets/quality-guidelines/publish', { tag: 'approved' });
    await h.api.put('/v1/secrets/anthropic-api-key', { value: 'sk-test' });
  });
  afterAll(async () => h?.stop());

  it('plans the quality-report package: capabilities, policy coverage and taint paths (golden)', async () => {
    const v = (await uploadDir(h.api, PKG)).version.id;
    const plan = normalise(await h.api.get<any>(`/v1/versions/${v}/plan`)) as any;
    expect(plan.ok).toBe(true);
    expect(plan.taint.tainted.analyse).toMatch(/untrusted|not marked trusted/);
    expect(plan.taint.paths).toContainEqual(expect.objectContaining({ agent: 'analyse', write: 'post', gate: 'guard' }));
    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(plan, null, 2)}\n`);
    expect(plan).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('rejects an ungated write after a tainted node at compile time', async () => {
    const dir = copyPackage((wf) => wf.replace(/\n\s*# Taint gate[\s\S]*$/, '\n'));
    expect(readFileSync(join(dir, 'workflow.yaml'), 'utf8')).not.toContain('guard:');
    const r = await uploadDir(h.api, dir).catch((e) => e.body);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'tainted_write_ungated', node: 'post' }));
  });

  it("refuses another author's package at plan time on a self-policy worker, and nothing executes", async () => {
    const other = new ApiClient(h.server.url, (await h.api.post<{ token: string }>('/v1/users', { display_name: 'other author', role: 'author' })).token);
    const dir = copyPackage((wf) => wf.replace('name: Weekly quality report', 'name: Weekly quality report (other author)'));
    const v = (await uploadDir(other, dir, { keyDir: mkdtempSync(join(tmpdir(), 'azhi-keys-')) })).version.id;
    const plan = await h.api.get<any>(`/v1/versions/${v}/plan`);
    expect(plan.ok).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'worker_trust_denied' }));
    const runsBefore = (await h.api.get<any[]>('/v1/runs')).length;
    await expect(h.api.post('/v1/runs', { version: v, inputs: { team: 'payments' } })).rejects.toThrow(/blocker/);
    expect((await h.api.get<any[]>('/v1/runs')).length).toBe(runsBefore);
  });
});
