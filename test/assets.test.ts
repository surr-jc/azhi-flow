import { describe, expect, it } from 'vitest';
import { openCodeGuide, renderOpenCode, validateAsset } from '../src/server/assets.js';

describe('portable asset OpenCode adapter', () => {
  it('renders local and remote MCP entries with environment references intact', () => {
    const files = renderOpenCode([{ kind: 'mcp', slug: 'docs', definition: { transport: 'remote', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer {env:DOCS_KEY}' } } }, { kind: 'mcp', slug: 'local-tools', definition: { transport: 'local', command: ['npx', '-y', 'tool-server'], environment: { TOKEN: '{env:TOKEN}' } } }]);
    const config = JSON.parse(files['opencode.jsonc']!);
    expect(config.mcp.docs).toMatchObject({ type: 'remote', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer {env:DOCS_KEY}' } });
    expect(config.mcp['local-tools']).toMatchObject({ type: 'local', command: ['npx', '-y', 'tool-server'] });
  });
  it('renders OpenCode-native agent, skill, and command files', () => {
    const files = renderOpenCode([{ kind: 'agent', slug: 'review', definition: { description: 'Review', prompt: 'Review carefully.' } }, { kind: 'skill', slug: 'release-notes', definition: { description: 'Release notes', instructions: 'Write notes.' } }, { kind: 'command', slug: 'review-pr', definition: { description: 'Review a PR', template: 'Review $ARGUMENTS' } }]);
    expect(files['.opencode/agents/review.md']).toContain('Review carefully.');
    expect(files['.opencode/skills/release-notes/SKILL.md']).toContain('name: release-notes');
    expect(files['.opencode/commands/review-pr.md']).toContain('Review $ARGUMENTS');
  });
  it('validates the required shape and gives an actionable MCP guide', () => {
    expect(validateAsset('mcp', 'bad name', { transport: 'remote', url: 'http://nope' })).not.toEqual([]);
    expect(openCodeGuide({ kind: 'mcp', slug: 'sentry', definition: { transport: 'remote', url: 'https://mcp.example.com', oauth: {} } }).steps.join(' ')).toContain('opencode mcp auth sentry');
  });
});
