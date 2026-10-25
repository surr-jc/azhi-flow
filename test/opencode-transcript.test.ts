import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../src/agents/transcript.js';
import { OpencodeTranscript } from '../src/worker/opencode-transcript.js';

/**
 * The OpenCode transcript on the v2 client: events are fed straight from a stub stream, so this runs without
 * OpenCode or Temporal. Newer servers stream text as `message.part.delta`; older ones put the delta on the part.
 */
type Ev = { type: string; properties: Record<string, unknown> };

async function run(events: Ev[]) {
  const entries = new Map<string, TranscriptEntry>();
  const calls: unknown[][] = [];
  const client = {
    event: {
      subscribe: async (...args: unknown[]) => {
        calls.push(args);
        return { stream: (async function* () { yield* events; })() };
      },
    },
  };
  const t = new OpencodeTranscript(client as never, { put: (e: TranscriptEntry) => entries.set(e.id, e) } as never);
  t.follow('s1');
  t.start();
  await new Promise((r) => setTimeout(r, 10));
  t.stop();
  return { entries, calls };
}

const message = (id = 'm1', sessionID = 's1'): Ev => ({ type: 'message.updated', properties: { info: { id, sessionID, role: 'assistant' } } });
const part = (text: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text }, ...extra } });
const delta = (d: string, sessionID = 's1'): Ev => ({ type: 'message.part.delta', properties: { sessionID, messageID: 'm1', partID: 'p1', field: 'text', delta: d } });

describe('OpenCode transcript (v2 events)', () => {
  it('passes the abort signal as a request option, not a query parameter', async () => {
    const { calls } = await run([]);
    expect(calls[0]![0]).toBeUndefined();
    expect(calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal), sseMaxRetryAttempts: 3 });
  });

  it('joins streamed deltas into the part text', async () => {
    const { entries } = await run([message(), part(''), delta('Hello, '), delta('world')]);
    expect(entries.get('p1')).toMatchObject({ kind: 'assistant', text: 'Hello, world' });
  });

  it('keeps deltas that arrive before their part', async () => {
    const { entries } = await run([message(), delta('Hel'), delta('lo'), part('')]);
    expect(entries.get('p1')).toMatchObject({ text: 'Hello' });
  });

  it('takes the full text over the deltas once it arrives, without doubling', async () => {
    const { entries } = await run([message(), part(''), delta('Hel'), delta('lo'), part('Hello')]);
    expect(entries.get('p1')).toMatchObject({ text: 'Hello' });
  });

  it('ignores deltas from another session', async () => {
    const { entries } = await run([message(), part(''), delta('mine'), delta(' theirs', 's2')]);
    expect(entries.get('p1')).toMatchObject({ text: 'mine' });
  });

  it('still reads a delta carried on the part (older servers)', async () => {
    const { entries } = await run([message(), part('', { delta: 'Hi' }), part('', { delta: ' there' })]);
    expect(entries.get('p1')).toMatchObject({ text: 'Hi there' });
  });
});
