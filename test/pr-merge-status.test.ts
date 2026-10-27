import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pullRequest } from '../src/gateway/tools/github.js';
import { renderReport } from '../src/runtime/report.js';
import { startFakeGithub } from '../src/testing/fake-github.js';

const base = { ref: 'main', sha: 'b'.repeat(40) };
const head = { ref: 'feature', sha: 'a'.repeat(40) };
const files = [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }];
const pr = (number: number, extra: object) => ({ number, title: `PR ${number}`, base, head, files, ...extra });

/** The pull request tool reports GitHub's mergeability and never calls an unknown one clean. */
describe('pull request merge status', () => {
  let gh: Awaited<ReturnType<typeof startFakeGithub>>;
  const cfg = () => ({ api_url: gh.url });
  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    gh = await startFakeGithub(
      {
        runs: [],
        issues: [],
        pulls: [
          pr(1, { mergeable: false, mergeable_state: 'dirty' }),
          pr(2, {}),
          pr(3, { mergeable: [null, null, false], mergeable_state: 'dirty' }),
          pr(4, { mergeable: null }),
          pr(5, { mergeable: true, mergeable_state: 'behind' }),
        ],
      },
      { token: 't' },
    );
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await gh.stop();
  });

  it('reports a conflict as dirty', async () => {
    const r = await pullRequest(cfg(), { repo: 'a/b', number: 1 }, 't', 10_000);
    expect(r).toMatchObject({ mergeable: false, mergeable_state: 'dirty' });
  });
  it('reports a clean pull request', async () => {
    expect(await pullRequest(cfg(), { repo: 'a/b', number: 2 }, 't', 10_000)).toMatchObject({ mergeable: true, mergeable_state: 'clean' });
    expect(await pullRequest(cfg(), { repo: 'a/b', number: 5 }, 't', 10_000)).toMatchObject({ mergeable: true, mergeable_state: 'behind' });
  });
  it('asks again while GitHub is still computing it', async () => {
    const r = await pullRequest(cfg(), { repo: 'a/b', number: 3 }, 't', 10_000);
    expect(r).toMatchObject({ mergeable: false, mergeable_state: 'dirty' });
    expect(gh.requests.filter((x) => x.endsWith('/pulls/3')).length).toBe(3);
  });
  it('says unknown, not clean, when it stays null', async () => {
    const r = await pullRequest(cfg(), { repo: 'a/b', number: 4 }, 't', 10_000);
    expect(r).toMatchObject({ mergeable: null, mergeable_state: 'unknown' });
  });
});

describe('review report merge line', () => {
  const template = readFileSync('examples/pr-review/templates/review.md', 'utf8');
  const render = (state: string) => {
    const pr = { repo: 'a/b', number: 1, title: 't', base_ref: 'release-v1.0.1', base_sha: 's', head_sha: 'h', additions: 1, deletions: 0, mergeable_state: state };
    const merge = { conflicts: state === 'dirty', behind: state === 'behind', blocked: state === 'blocked', unknown: state === 'unknown' };
    return renderReport(template, { pr, merge, review: { verdict: 'approve', summary: 's', findings: [] } }, { asOf: {}, format: 'markdown' }).markdown;
  };
  it('puts conflicts above the verdict and stays quiet when clean', () => {
    const dirty = render('dirty');
    expect(dirty).toContain('Merge status: CONFLICTS with release-v1.0.1');
    expect(dirty.indexOf('Merge status')).toBeLessThan(dirty.indexOf('Verdict'));
    expect(render('clean')).not.toContain('Merge status');
    expect(render('behind')).toContain('behind release-v1.0.1');
    expect(render('unknown')).toContain('UNKNOWN');
  });
});
