import { redactor, type TranscriptEntry } from '../agents/transcript.js';
import type { ApiClient } from './api-client.js';

/**
 * Sends an agent step's transcript to the server while the step runs. Entries are redacted here
 * (the step's own secrets never leave the worker) and again on the server. Sending is best effort:
 * a failed send is retried with the next batch and never fails the step.
 */
export class TranscriptSink {
  private pending = new Map<string, TranscriptEntry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private off = false;
  private readonly redact: (s: string) => string;

  constructor(
    private readonly api: ApiClient,
    private readonly attempt: number,
    secrets: Array<string | undefined>,
    private readonly delayMs = 700,
  ) {
    this.redact = redactor(secrets);
  }

  /** Queues an entry; a later entry with the same id replaces it. */
  put(e: TranscriptEntry) {
    if (this.off) return;
    this.pending.set(e.id, e);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Sends what is queued; resolves once it is sent (or given up on). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sending = this.sending.then(async () => {
      if (this.off || !this.pending.size) return;
      const batch = [...this.pending.values()].slice(0, 200);
      for (const e of batch) this.pending.delete(e.id);
      try {
        const r = await this.api.post<{ enabled?: boolean }>('/v1/gateway/transcript', { attempt: this.attempt, entries: batch.map((e) => this.scrub(e)) });
        if (r?.enabled === false) this.off = true;
      } catch (err) {
        // A server without the endpoint (older version) is not retried; anything else is, with the next batch.
        if ((err as { status?: number }).status === 404) this.off = true;
        else for (const e of batch) if (!this.pending.has(e.id)) this.pending.set(e.id, e);
      }
      if (this.pending.size && !this.off && !this.timer) this.timer = setTimeout(() => void this.flush(), this.delayMs * 3);
    });
    return this.sending;
  }

  /** Sends the rest and stops; waits at most `ms`. */
  async close(ms = 5000) {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, ms))]);
    this.off = true;
    clearTimeout(this.timer);
  }

  private scrub(e: TranscriptEntry): TranscriptEntry {
    const r = (x: unknown) => (typeof x === 'string' ? this.redact(x) : x);
    return {
      ...e,
      ...(e.text !== undefined ? { text: r(e.text) as string } : {}),
      ...(e.output !== undefined ? { output: r(e.output) as string } : {}),
      ...(e.error !== undefined ? { error: r(e.error) as string } : {}),
      ...(e.input !== undefined ? { input: this.scrubJson(e.input) } : {}),
    };
  }

  private scrubJson(v: unknown): unknown {
    try {
      return JSON.parse(this.redact(JSON.stringify(v) ?? 'null'));
    } catch {
      return '[input not shown: it could not be redacted]';
    }
  }
}

/**
 * Transcript entries from Anthropic-style content blocks (the Claude Agent SDK's messages): text,
 * thinking, and tool calls whose results arrive in a later user message.
 */
export class BlockTranscript {
  private calls = new Map<string, TranscriptEntry>();
  private n = 0;

  constructor(private readonly sink: TranscriptSink) {}

  assistant(content: unknown, model?: string) {
    if (!Array.isArray(content)) return;
    const turn = ++this.n;
    content.forEach((b: any, i: number) => {
      const id = `t${turn}-${i}`;
      if (b?.type === 'text' && b.text) this.sink.put({ id, kind: 'assistant', text: b.text, model, at: Date.now() });
      else if ((b?.type === 'thinking' || b?.type === 'redacted_thinking') && (b.thinking || b.type === 'redacted_thinking')) this.sink.put({ id, kind: 'reasoning', text: b.thinking ?? '[reasoning withheld by the provider]', at: Date.now() });
      else if (b?.type === 'tool_use') {
        const e: TranscriptEntry = { id: `tool-${b.id}`, kind: 'tool', tool: b.name, status: 'running', input: b.input, at: Date.now() };
        this.calls.set(b.id, e);
        this.sink.put(e);
      }
    });
  }

  user(content: unknown) {
    if (typeof content === 'string') return void this.sink.put({ id: `u${++this.n}`, kind: 'user', text: content, at: Date.now() });
    if (!Array.isArray(content)) return;
    const turn = ++this.n;
    content.forEach((b: any, i: number) => {
      if (b?.type === 'text' && b.text) this.sink.put({ id: `u${turn}-${i}`, kind: 'user', text: b.text, at: Date.now() });
      else if (b?.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n') : JSON.stringify(b.content ?? '');
        const prev = this.calls.get(b.tool_use_id) ?? { id: `tool-${b.tool_use_id}`, kind: 'tool' as const, at: Date.now() };
        this.sink.put({ ...prev, status: b.is_error ? 'error' : 'completed', ...(b.is_error ? { error: text } : { output: text }) });
      }
    });
  }
}
