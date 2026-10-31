import { describe, expect, it } from 'vitest';
import { withheldBefore } from '../src/runtime/withheld.js';
import { approvalBlocks } from '../src/server/approvals.js';

/** An approval tells its approver which input an agent before it was not sent. */
const nodes = [
  { id: 'gather', deps: [] },
  { id: 'draft', deps: ['gather'] },
  { id: 'critique', deps: ['draft'] },
  { id: 'side', deps: ['gather'] },
  { id: 'approve', deps: ['critique'] },
  { id: 'after', deps: ['approve'] },
];

describe('withheldBefore', () => {
  it('keeps the fields withheld from a step the approval waits on, directly or through others', () => {
    expect(withheldBefore(nodes, ['critique.draft'], 'approve')).toEqual(['critique.draft']);
    expect(withheldBefore(nodes, ['draft.facts', 'critique.draft'], 'approve')).toEqual(['draft.facts', 'critique.draft']);
  });

  it('drops a field withheld from a step on another branch or after the approval', () => {
    expect(withheldBefore(nodes, ['side.facts', 'after.x', 'approve.y'], 'approve')).toEqual([]);
    expect(withheldBefore(nodes, ['critique.draft', 'side.facts', 'after.x'], 'approve')).toEqual(['critique.draft']);
  });

  it('does not confuse steps whose names start the same', () => {
    const ns = [{ id: 'a', deps: [] }, { id: 'ab', deps: [] }, { id: 'ok', deps: ['a'] }];
    expect(withheldBefore(ns, ['ab.x', 'a.x'], 'ok')).toEqual(['a.x']);
  });

  it('is empty when nothing was withheld, or the approval is unknown', () => {
    expect(withheldBefore(nodes, undefined, 'approve')).toEqual([]);
    expect(withheldBefore(nodes, [], 'approve')).toEqual([]);
    expect(withheldBefore(nodes, ['critique.draft'], 'nope')).toEqual([]);
  });

  it('terminates on a graph that loops back (a loop body re-reads a step)', () => {
    const looped = [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }, { id: 'ok', deps: ['a'] }];
    expect(withheldBefore(looped, ['b.x'], 'ok')).toEqual(['b.x']);
  });
});

describe('Slack approval message', () => {
  const base = { runId: 'r1', nodeId: 'approve', workflow: 'w', message: 'Ship it?', payload: { a: 1 }, role: 'author', expires_at: '2026-11-01T00:00:00Z', baseUrl: 'https://azhi.example' };
  const texts = (blocks: Array<Record<string, any>>) => blocks.map((b) => b.text?.text ?? b.elements?.[0]?.text ?? '').join('\n');

  it('names the withheld fields, between the details and the buttons', () => {
    const blocks = approvalBlocks({ ...base, context_withheld: ['critique.draft', 'draft.facts'] }) as Array<Record<string, any>>;
    const warn = blocks.findIndex((b) => b.text?.text?.includes('was not sent'));
    expect(warn).toBeGreaterThan(0);
    expect(blocks[warn]!.text.text).toContain('`critique.draft`, `draft.facts`');
    expect(blocks[warn]!.text.text).toContain('could not read them');
    expect(blocks[warn + 1]!.type).toBe('context');
    expect(blocks.at(-1)!.type).toBe('actions');
  });

  it('says it for one field in the singular', () => {
    expect(texts(approvalBlocks({ ...base, context_withheld: ['critique.draft'] }) as never)).toContain('could not read it,');
  });

  it('is unchanged when nothing was withheld', () => {
    expect(approvalBlocks({ ...base, context_withheld: [] })).toEqual(approvalBlocks(base));
    expect(texts(approvalBlocks(base) as never)).not.toContain('was not sent');
  });
});
