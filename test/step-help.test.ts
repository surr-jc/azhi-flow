import { describe, expect, it } from 'vitest';
import { effectsOf, helpFor, keySettings, sentenceOf } from '../web/src/stepHelp.js';

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
  it('lists the key settings shown on canvas cards', () => {
    const agent = keySettings({ type: 'agent', profile: 'security-reviewer@1', executor: 'opencode', timeout: '15m', budget: { max_tool_calls: 10 }, input: { map: "{'pr': nodes.pr.output}" } }, tools);
    expect(agent.slice(0, 3).map((r) => [r.label, r.value])).toEqual([['Profile', 'security-reviewer@1'], ['Runs on', 'opencode'], ['Limits', '15m · 10 tool calls']]);
    expect(agent.find((r) => r.label === 'Gets')?.value).toBe('pr');
    const post = keySettings({ type: 'tool', tool: 'github.comment-on-pr@1', guard: 'args.repo == inputs.repo', arguments: { repo: { ref: 'inputs.repo' } } }, tools);
    expect(post.map((r) => r.label)).toEqual(['Uses', 'Effect', 'Guard', 'Gets']);
    expect(post[1]).toMatchObject({ value: 'writes to github', tone: 'warn', keys: ['tool'] });
    expect(keySettings({ type: 'approval', role: 'author' }, tools).find((r) => r.label === 'Shows')).toMatchObject({ value: 'no details', tone: 'warn' });
  });
});
