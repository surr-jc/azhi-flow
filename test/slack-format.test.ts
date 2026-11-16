import { describe, expect, it } from 'vitest';
import { approvalBlocks, commentModal, decidedBlocks } from '../src/server/approvals.js';
import { notificationBlocks } from '../src/gateway/tools/slack-format.js';

const base = { runId: 'run_1', nodeId: 'review', workflow: 'pr-review', message: 'Merge it?', payload: { pr: 7 }, role: 'operator', expires_at: '2026-11-05T10:00:00.000Z', baseUrl: 'https://azhi.test/' };

describe('Slack message layouts', () => {
  it('shows who, what and where on a notification, and links to the run', () => {
    const blocks = notificationBlocks({ workflow: 'ci-digest', runId: 'run_9', nodeId: 'tell', text: 'Build is green', baseUrl: 'https://azhi.test', at: new Date('2026-11-04T09:00:00Z') }) as any[];
    expect(blocks[0]).toMatchObject({ type: 'header' });
    expect(blocks[1].text.text).toBe('Build is green');
    expect(JSON.stringify(blocks)).toContain('https://azhi.test/ui/runs/run_9');
    expect(blocks.at(-1).elements[0].url).toBe('https://azhi.test/ui/runs/run_9');
  });

  it('keeps every section under Slack\'s 3000 character limit', () => {
    const blocks = notificationBlocks({ workflow: 'w', runId: 'r', nodeId: 'n', text: 'x'.repeat(9000), baseUrl: 'https://azhi.test' }) as any[];
    for (const b of blocks) if (b.text?.type === 'mrkdwn') expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });

  it('offers Approve, Reject and Comment on an approval', () => {
    const actions = (approvalBlocks(base) as any[]).find((b) => b.type === 'actions');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(['approve', 'reject', 'comment', 'open']);
    expect(JSON.parse(actions.elements[2].value)).toEqual({ run: 'run_1', node: 'review' });
  });

  it('drops the buttons and adds a status line once decided', () => {
    const decided = decidedBlocks(approvalBlocks(base), ':white_check_mark: *Approved* by <@U1>') as any[];
    expect(decided.some((b) => b.type === 'actions')).toBe(false);
    expect(decided.at(-1).text.text).toContain('Approved');
    expect(decidedBlocks(undefined, 'done')).toHaveLength(1);
  });

  it('builds a comment modal that remembers the run and step', () => {
    const m = commentModal({ run: 'run_1', node: 'review', intro: 'hi' });
    expect(m.callback_id).toBe('azhi_approval_comment');
    expect(JSON.parse(m.private_metadata)).toEqual({ run: 'run_1', node: 'review' });
  });
});
