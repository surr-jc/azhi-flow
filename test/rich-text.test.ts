import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Formatted, Markdown, parseJsonText, plainText, toMarkdown } from '../web/src/components/Rich.js';

const md = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const value = (v: unknown, plain?: boolean) => renderToStaticMarkup(createElement(Formatted, { value: v, plain }));

describe('agent text rendering', () => {
  it('renders GitHub-flavored Markdown', () => {
    const html = md('## Design\n\n- **one**\n- `two`\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h2>Design</h2>');
    expect(html).toContain('<strong>one</strong>');
    expect(html).toContain('<code>two</code>');
    expect(html).toContain('<table>');
  });

  it('drops raw HTML and unsafe links, and opens links safely', () => {
    const html = md('<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](https://example.com) ![pic](https://example.com/p.png)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer nofollow"');
  });

  it('shows structured payloads as Markdown, not JSON', () => {
    const html = value({ design: '## Plan\n\n1. Add a gate\n2. Wire it', requirements: [{ id: 'R1', text: 'Only OpenCode' }], nested: { deep: { a: 1 } } });
    expect(html).toContain('<h3>Design</h3>');
    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<strong>Text:</strong> Only OpenCode');
    expect(html).toContain('<h3>Nested</h3>');
    expect(html).not.toContain('see the full payload');
    expect(html).not.toContain('{&quot;');
  });

  it('parses JSON held in strings and keeps tool text preformatted', () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('not json')).toBeUndefined();
    expect(toMarkdown({ files: ['a.ts', 'b.ts'] })).toContain('### Files\n\n- a.ts\n- b.ts');
    expect(value('echo hi\nls **/x', true)).toContain('<pre><code>echo hi');
    expect(toMarkdown({ command: 'node -e "x"', status: 'failed' })).toBe('### Command\n\n```\nnode -e "x"\n```\n\n- **Status:** failed');
    expect(renderToStaticMarkup(createElement(Formatted, { value: { a: 1 } }))).toContain('Show raw JSON');
  });

  it('reduces Markdown to plain words for summaries', () => {
    expect(plainText('## Title\n- **bold** and `code` [link](https://x)')).toBe('Title bold and code link');
  });
});
