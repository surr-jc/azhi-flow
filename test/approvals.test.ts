import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/worker/api-client.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

const up = await temporalAvailable();

async function waitForApproval(api: ApiClient, runId: string) {
  for (let i = 0; i < 100; i++) {
    const d = await api.get<any>(`/v1/runs/${runId}`);
    if (d.run.state === 'waiting' && d.run.flags?.waiting_reason?.reason === 'approval') return d;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`run ${runId} never waited for approval`);
}

describe.skipIf(!up)('approvals', () => {
  let h: Harness;
  let viewer: ApiClient;
  let version: string;
  beforeAll(async () => {
    h = await startHarness({ worker: false });
    for (const t of parse(readFileSync('examples/ci-digest/azhi.config.yaml', 'utf8')).tools) await h.api.post('/v1/tools', t);
    const u = await h.api.post<{ token: string }>('/v1/users', { display_name: 'viewer', role: 'viewer' });
    viewer = new ApiClient(h.server.url, u.token);
    version = (await uploadDir(h.api, 'test/fixtures/approval')).version.id;
  });
  afterAll(async () => h?.stop());

  it('waits with the concrete payload, checks role and schema, then resumes on approval', async () => {
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    const d = await waitForApproval(h.api, run_id);
    expect(d.run.flags.waiting_reason.node).toBe('approve');
    expect(d.approvals).toHaveLength(1);
    expect(d.approvals[0].decision).toBeNull();
    expect(d.approvals[0].request).toMatchObject({ message: 'Post 4 runs to C-QUALITY?', role: 'operator', on_expiry: 'reject' });
    expect(d.approvals[0].request.payload.destination).toBe('C-QUALITY');

    await expect(viewer.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'approved' })).rejects.toThrow(/requires role operator/);
    await expect(h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'approved', data: { bogus: 1 } })).rejects.toThrow(/decision schema/);
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'approved', data: { note: 'ship it' } });

    const done = await waitForRun(h.api, run_id);
    expect(done.run.state).toBe('succeeded');
    expect(done.approvals[0]).toMatchObject({ decision: 'approved', decided_by: 'usr_local', data: { note: 'ship it' } });
    expect(h.slack.messages.map((m) => m.text)).toContain('approved by usr_local');
    await expect(h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'rejected' })).rejects.toThrow(/already decided/);
  });

  it('skips everything downstream of a rejection', async () => {
    const before = h.slack.messages.length;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version, inputs: { team: 'payments' } });
    await waitForApproval(h.api, run_id);
    await h.api.post(`/v1/runs/${run_id}/approvals`, { node: 'approve', decision: 'rejected' });
    const done = await waitForRun(h.api, run_id);
    expect(done.run.state).toBe('succeeded');
    expect(done.attempts.find((a: any) => a.node_id === 'post').state).toBe('skipped');
    expect(h.slack.messages.length).toBe(before);
  });

  it('expires the run when an approval with on_expiry fail times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-approval-'));
    cpSync('test/fixtures/approval', dir, { recursive: true });
    const wf = join(dir, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('expires_in: 1h', 'expires_in: 2s').replace('on_expiry: reject', 'on_expiry: fail'));
    const v = (await uploadDir(h.api, dir)).version.id;
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v, inputs: { team: 'payments' } });
    const done = await waitForRun(h.api, run_id);
    expect(done.run.state).toBe('expired');
    expect(done.approvals[0].decision).toBe('expired');
  });
});
