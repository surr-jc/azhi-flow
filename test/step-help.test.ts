import { describe, expect, it } from 'vitest';
import { effectsOf, helpFor, sentenceOf } from '../web/src/stepHelp';

const tools = [
  { id: 'github.comment-on-pr', version: 1, effect: 'write-dedupable', description: 'Post a comment on a pull request (GitHub)' },
  { id: 'github.get-pull-request', version: 1, effect: 'read' },
];

describe('step help', () => {
  it('labels writes and reads', () => {
    expect(effectsOf({ type: 'tool', tool: 'github.comment-on-pr@1' }, tools)).toEqual([{ label: 'writes to github', tone: 'warn' }]);
    expect(effectsOf({ type: 'tool', tool: 'github.get-pull-request@1' }, tools)[0]?.tone).toBe('ok');
    expect(effectsOf({ type: 'notify' }, tools)[0]?.label).toBe('sends Slack message');
  });
  it('reads a step as a sentence', () => {
    expect(sentenceOf({ type: 'tool', tool: 'github.comment-on-pr@1' }, tools, ['summarize'])).toContain('changes something outside Azhi');
    expect(sentenceOf({ type: 'approval', role: 'operator' }, tools, [])).toContain('no details');
  });
  it('has help for shared and typed settings', () => {
    expect(helpFor('agent', 'budget')).toContain('max_tool_calls');
    expect(helpFor('tool', 'timeout')).toContain('stopped');
  });
});
