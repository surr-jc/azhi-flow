import type { createOpencodeClient } from '@opencode-ai/sdk';
import type { TranscriptEntry } from '../agents/transcript.js';
import type { TranscriptSink } from './transcript.js';

type Client = ReturnType<typeof createOpencodeClient>;
type AnyPart = { id: string; sessionID: string; messageID: string; type: string; [k: string]: any };
type AnyMessage = { id: string; sessionID: string; role: 'user' | 'assistant'; modelID?: string; providerID?: string; error?: { name: string; data?: { message?: string } }; time?: { created?: number } };

/**
 * Turns an OpenCode session into transcript entries: the user's messages, the model's text and
 * reasoning, each tool call as it moves from pending to completed or error, and each model call's
 * tokens. Parts are followed live from OpenCode's event stream; `backfill` adds anything the
 * stream missed from the session's stored messages.
 */
export class OpencodeTranscript {
  private sessionId: string | undefined;
  private roles = new Map<string, AnyMessage>();
  private parts = new Map<string, AnyPart>();
  private abort = new AbortController();

  constructor(
    private readonly client: Client,
    private readonly sink: TranscriptSink,
  ) {}

  /** Starts following the event stream; call before the session's first prompt. */
  start() {
    void (async () => {
      try {
        const sub = await this.client.event.subscribe({ signal: this.abort.signal, sseMaxRetryAttempts: 3 } as never);
        for await (const ev of sub.stream as AsyncIterable<{ type: string; properties: any }>) {
          if (this.abort.signal.aborted) break;
          this.onEvent(ev);
        }
      } catch {
        /* the stream ended with the server, or was stopped; backfill covers the rest */
      }
    })();
  }

  follow(sessionId: string) {
    this.sessionId = sessionId;
  }

  stop() {
    this.abort.abort();
  }

  /** Adds the session's stored messages (the stream may have missed some). */
  backfill(messages: Array<{ info: AnyMessage; parts?: AnyPart[] }>) {
    for (const m of messages) {
      this.onMessage(m.info);
      for (const p of m.parts ?? []) this.onPart(p);
    }
  }

  private onEvent(ev: { type: string; properties: any }) {
    if (ev.type === 'message.updated') this.onMessage(ev.properties.info);
    else if (ev.type === 'message.part.updated') this.onPart(ev.properties.part, ev.properties.delta);
    else if (ev.type === 'session.error' && ev.properties?.sessionID === this.sessionId && ev.properties?.error) {
      const e = ev.properties.error;
      this.sink.put({ id: `session-error-${Date.now()}`, kind: 'error', text: `${e.name ?? 'error'}: ${e.data?.message ?? JSON.stringify(e.data ?? {})}`, at: Date.now() });
    }
  }

  private onMessage(info: AnyMessage | undefined) {
    if (!info || info.sessionID !== this.sessionId) return;
    const before = this.roles.get(info.id);
    this.roles.set(info.id, info);
    // A part seen before its message was filed as the model's; file it again now the role is known.
    if (!before) for (const p of this.parts.values()) if (p.messageID === info.id) this.emit(p);
    if (info.role === 'assistant' && info.error && info.error.name !== 'MessageAbortedError') {
      this.sink.put({ id: `${info.id}-error`, kind: 'error', text: `${info.error.name}: ${info.error.data?.message ?? ''}`.trim(), model: info.modelID, at: Date.now() });
    }
  }

  private onPart(part: AnyPart | undefined, delta?: string) {
    if (!part || part.sessionID !== this.sessionId) return;
    const prev = this.parts.get(part.id);
    // Text streams in; a part sent with only its newest piece keeps what came before.
    if ((part.type === 'text' || part.type === 'reasoning') && !part.text && delta) part = { ...part, text: `${prev?.text ?? ''}${delta}` };
    this.parts.set(part.id, part);
    this.emit(part);
  }

  private emit(p: AnyPart) {
    const msg = this.roles.get(p.messageID);
    const at = p.time?.start ?? p.state?.time?.start ?? msg?.time?.created;
    let e: TranscriptEntry | undefined;
    switch (p.type) {
      case 'text':
        if (p.ignored || !p.text) return;
        e = { id: p.id, kind: msg?.role === 'user' ? 'user' : 'assistant', text: p.text, at };
        break;
      case 'reasoning':
        if (!p.text) return;
        e = { id: p.id, kind: 'reasoning', text: p.text, at };
        break;
      case 'tool': {
        const s = p.state ?? {};
        e = {
          id: p.id,
          kind: 'tool',
          tool: p.tool,
          status: s.status,
          input: s.input && Object.keys(s.input).length ? s.input : s.raw ? s.raw : undefined,
          ...(s.status === 'completed' ? { output: typeof s.output === 'string' ? s.output : JSON.stringify(s.output) } : {}),
          ...(s.status === 'error' ? { error: String(s.error) } : {}),
          at,
        };
        break;
      }
      case 'step-finish':
        e = {
          id: p.id,
          kind: 'step',
          model: msg?.modelID,
          text: p.reason,
          tokens: { input: p.tokens?.input, output: p.tokens?.output, reasoning: p.tokens?.reasoning, cache_read: p.tokens?.cache?.read, cache_write: p.tokens?.cache?.write },
          at: Date.now(),
        };
        break;
      case 'retry':
        e = { id: p.id, kind: 'error', text: `Model call failed, retrying (attempt ${p.attempt}): ${p.error?.data?.message ?? ''}`.trim(), at: p.time?.created };
        break;
      case 'compaction':
        e = { id: p.id, kind: 'note', text: 'OpenCode compacted the conversation to fit the context window.', at };
        break;
      case 'subtask':
        e = { id: p.id, kind: 'note', text: `Subtask for agent ${p.agent}: ${p.description}`, at };
        break;
      default:
        return;
    }
    this.sink.put(e);
  }
}
