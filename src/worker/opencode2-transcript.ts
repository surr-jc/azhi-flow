import type { OpenCodeClient } from '@opencode/client';
import type { TranscriptEntry } from '../agents/transcript.js';
import type { TranscriptSink } from './transcript.js';

type Event = { type: string; data?: any };
type Message = { id: string; type: string; text?: string; model?: { id: string }; content?: any[]; error?: { type: string; message: string }; time?: { created?: number }; tokens?: any };
type ToolEntry = TranscriptEntry & { kind: 'tool' };

const toolText = (content: unknown): string | undefined =>
  Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n') : undefined;

/**
 * The OpenCode 2 version of `OpencodeTranscript`. OpenCode 2 streams typed `session.*` events (text and reasoning
 * deltas by ordinal, tool calls by call id, step ends with tokens) and stores messages whose content is a list of
 * text, reasoning and tool blocks. Entries use the same ids live and in `backfill`, so the stored transcript is
 * updated in place, not duplicated.
 */
export class Opencode2Transcript {
  private sessionId: string | undefined;
  private model: string | undefined;
  private texts = new Map<string, TranscriptEntry>();
  private tools = new Map<string, ToolEntry>();
  /** Assistant messages whose text arrived live; backfill leaves their text alone (it has no ordinals). */
  private streamed = new Set<string>();
  /** User input sent, by inbox id, until OpenCode delivers it to the session. */
  private inbox = new Map<string, string>();
  private abort = new AbortController();

  constructor(
    private readonly client: OpenCodeClient,
    private readonly sink: TranscriptSink,
  ) {}

  /** Starts following the event stream; call before the session's first prompt. */
  start() {
    void (async () => {
      try {
        for await (const ev of this.client.event.subscribe({ signal: this.abort.signal }) as AsyncIterable<Event>) {
          if (this.abort.signal.aborted) break;
          this.onEvent(ev);
        }
      } catch {
        /* the stream ended with the server, or was stopped; backfill covers the rest */
      }
    })();
  }

  follow(sessionId: string, model: string) {
    this.sessionId = sessionId;
    this.model = model;
  }

  /** Input queued with `session.prompt`; shown when OpenCode hands it to the model. */
  sent(inboxId: string, text: string) {
    this.inbox.set(inboxId, text);
  }

  stop() {
    this.abort.abort();
  }

  /** Adds the session's stored messages (the stream may have missed some). */
  backfill(messages: Message[]) {
    for (const m of messages) {
      if (m.type === 'user' && m.text) this.sink.put({ id: m.id, kind: 'user', text: m.text, at: m.time?.created });
      if (m.type !== 'assistant') continue;
      (m.content ?? []).forEach((c: any, i: number) => {
        if (c.type === 'tool') this.putTool(c.id, { tool: c.name, status: c.state?.status === 'streaming' ? 'pending' : c.state?.status, input: c.state?.input, output: c.state?.status === 'completed' ? toolText(c.state.content) : undefined, error: c.state?.status === 'error' ? c.state.error?.message : undefined, at: c.time?.created });
        else if (!this.streamed.has(m.id) && (c.type === 'text' || c.type === 'reasoning') && c.text) this.sink.put({ id: `${m.id}-${c.type}-${i}`, kind: c.type === 'text' ? 'assistant' : 'reasoning', text: c.text, at: m.time?.created });
      });
      if (m.tokens) this.putStep(m.id, m.tokens, m.model?.id);
      if (m.error && m.error.type !== 'aborted') this.sink.put({ id: `${m.id}-error`, kind: 'error', text: `${m.error.type}: ${m.error.message}`, model: m.model?.id, at: Date.now() });
    }
  }

  private onEvent(ev: Event) {
    const d = ev.data;
    if (!d || d.sessionID !== this.sessionId) return;
    switch (ev.type) {
      case 'session.inbox.delivered': {
        const text = this.inbox.get(d.inboxID);
        if (text !== undefined) this.sink.put({ id: d.inboxID, kind: 'user', text, at: Date.now() });
        return;
      }
      case 'session.text.delta':
      case 'session.reasoning.delta':
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const kind = ev.type.startsWith('session.text') ? 'assistant' : 'reasoning';
        const id = `${d.assistantMessageID}-${kind}-o${d.ordinal}`;
        const prev = this.texts.get(id);
        const text = ev.type.endsWith('.ended') ? d.text : `${prev?.text ?? ''}${d.delta ?? ''}`;
        if (!text) return;
        this.streamed.add(d.assistantMessageID);
        const e: TranscriptEntry = { id, kind, text, at: prev?.at ?? Date.now() };
        this.texts.set(id, e);
        this.sink.put(e);
        return;
      }
      case 'session.tool.input.started':
        return this.putTool(d.id, { tool: d.name, status: 'pending', at: Date.now() });
      case 'session.tool.called':
        return this.putTool(d.id, { status: 'running', input: d.input });
      case 'session.tool.success':
        return this.putTool(d.id, { status: 'completed', output: toolText(d.content) });
      case 'session.tool.failed':
        return this.putTool(d.id, { status: 'error', error: d.error?.message ?? JSON.stringify(d.error ?? {}) });
      case 'session.step.ended':
        return this.putStep(d.assistantMessageID, d.tokens, this.model, d.finish);
      case 'session.step.failed':
      case 'session.execution.failed':
        if (d.error?.type === 'aborted') return;
        return void this.sink.put({ id: `${d.assistantMessageID ?? 'session'}-error-${Date.now()}`, kind: 'error', text: `${d.error?.type ?? 'error'}: ${d.error?.message ?? ''}`.trim(), model: this.model, at: Date.now() });
      case 'session.retry.scheduled':
        return void this.sink.put({ id: `${d.assistantMessageID}-retry-${d.attempt}`, kind: 'error', text: `Model call failed, retrying (attempt ${d.attempt}): ${d.error?.message ?? ''}`.trim(), at: Date.now() });
      case 'session.compaction.started':
        return void this.sink.put({ id: `compaction-${Date.now()}`, kind: 'note', text: 'OpenCode compacted the conversation to fit the context window.', at: Date.now() });
    }
  }

  private putTool(callId: string | undefined, patch: Partial<TranscriptEntry>) {
    if (!callId) return;
    const prev = this.tools.get(callId);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const e = { ...(prev ?? { id: `tool-${callId}`, kind: 'tool' as const, at: Date.now() }), ...defined } as ToolEntry;
    if (e.input && typeof e.input === 'object' && !Object.keys(e.input).length) delete e.input;
    this.tools.set(callId, e);
    this.sink.put(e);
  }

  private putStep(messageId: string, t: any, model: string | undefined, finish?: string) {
    if (!t) return;
    this.sink.put({ id: `${messageId}-step`, kind: 'step', model, text: finish, tokens: { input: t.input, output: t.output, reasoning: t.reasoning, cache_read: t.cache?.read, cache_write: t.cache?.write }, at: Date.now() });
  }
}
