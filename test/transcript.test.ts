import { describe, expect, it } from 'vitest';
import { redactor, scrubEntry, TRANSCRIPT_FIELD_MAX } from '../src/agents/transcript.js';

describe('agent transcript redaction', () => {
  const redact = redactor(['my-provider-key-123', 'short']);

  it('removes known secret values and token-shaped strings', () => {
    const s = redact('key my-provider-key-123, gh ghp_abcdefghijklmnopqrstuvwxyz0123, anthropic sk-ant-api03-abcdefghijklmnopqrstu, Authorization: Bearer abcdefghijklmnopqrstuvwxyz, slack xoxb-1234567890-abcdef, run azr.eyJhIjoxfQ.c2lnbmF0dXJl');
    expect(s).not.toMatch(/my-provider-key|ghp_|sk-ant|abcdefghijklmnopqrstuvwxyz|xoxb|azr\./);
    expect(s).toContain('Bearer [redacted]');
    // Values under 8 characters are left alone: they would blank ordinary words.
    expect(redact('a short note')).toBe('a short note');
  });

  it('redacts tool inputs, credential-named fields and bounds long text', () => {
    const e = scrubEntry({ id: 'x', kind: 'tool', tool: 't', input: { query: 'uses my-provider-key-123', api_key: 'anything', nested: [{ token: 'abc' }] }, output: 'y'.repeat(TRANSCRIPT_FIELD_MAX + 1000) }, redact)!;
    expect(e.input).toEqual({ query: 'uses [redacted]', api_key: '[redacted]', nested: [{ token: '[redacted]' }] });
    expect(e.output!.length).toBeLessThanOrEqual(TRANSCRIPT_FIELD_MAX);
    expect(e.output).toContain('characters not kept');
  });

  it('drops entries of unknown kinds and unknown fields', () => {
    expect(scrubEntry({ id: 'x', kind: 'shell' } as never, redact)).toBeUndefined();
    expect(scrubEntry({ id: 'x', kind: 'note', text: 'hi', extra: 1 } as never, redact)).toEqual({ id: 'x', kind: 'note', text: 'hi' });
  });
});
