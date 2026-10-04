import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { ScriptedTurn } from './profile.js';

/** Provider-neutral transcript blocks; they map one to one onto the Anthropic Messages API. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ModelTool[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Unknown is null, never zero (spec section 11). */
export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface ModelResponse {
  content: Block[];
  stop: 'end' | 'tool_use' | 'max_tokens';
  usage: Usage;
  model: string;
}

export interface ModelProvider {
  id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export const UNKNOWN_USAGE: Usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null };

/** Anthropic Messages API. The stable system prompt is marked for prefix caching. */
export function anthropicProvider(o: { apiUrl: string; apiKey: string }): ModelProvider {
  return {
    id: 'anthropic',
    async complete(req) {
      const res = await fetch(`${o.apiUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages,
          tools: req.tools,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
        signal: req.signal,
      });
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AzhiError(ErrorClass.transient, `anthropic returned HTTP ${res.status} with a non-JSON body`);
      }
      if (!res.ok) {
        const message = `anthropic HTTP ${res.status}: ${body?.error?.message ?? text.slice(0, 200)}`;
        if (res.status === 401 || res.status === 403) throw new AzhiError(ErrorClass.authorization, message);
        if (res.status === 400 || res.status === 404) throw new AzhiError(ErrorClass.invalidInput, message);
        throw new AzhiError(ErrorClass.transient, message);
      }
      const u = body.usage ?? {};
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        content: (body.content ?? []).filter((b: Block) => b.type === 'text' || b.type === 'tool_use'),
        stop: body.stop_reason === 'tool_use' ? 'tool_use' : body.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
        usage: {
          input_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
          cache_read_tokens: num(u.cache_read_input_tokens),
          cache_write_tokens: num(u.cache_creation_input_tokens),
          reasoning_tokens: null,
        },
        model: body.model ?? req.model,
      };
    },
  };
}

/**
 * Plays a fixed script, one entry per model turn: a tool call, a final output, or plain text.
 * Usage is a fixed estimate unless an entry sets `usage: null` to simulate an executor that
 * does not report it. Used by fixtures and tests; never billed.
 */
export function scriptedProvider(script: ScriptedTurn[]): ModelProvider {
  return {
    id: 'scripted',
    async complete(req) {
      const turn = req.messages.filter((m) => m.role === 'assistant').length;
      const entry = script[Math.min(turn, script.length - 1)] as Record<string, unknown> | undefined;
      const usage: Usage =
        entry && 'usage' in entry && entry.usage === null ? UNKNOWN_USAGE : { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null };
      const id = `call_${turn + 1}`;
      // `{{chunk:N}}` in a scripted output stands for the Nth excerpt ID the agent was shown.
      const shown = [...JSON.stringify(req.messages[0]?.content ?? []).matchAll(/\[(c_[0-9a-f]{20})\]/g)].map((m) => m[1]!);
      const fill = (v: unknown): unknown =>
        typeof v === 'string'
          ? v.replace(/\{\{chunk:(\d+)\}\}/g, (_, n) => shown[Number(n)] ?? 'c_00000000000000000000')
          : Array.isArray(v)
            ? v.map(fill)
            : v && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
              : v;
      if (entry && 'tool' in entry) return { content: [{ type: 'tool_use', id, name: toolName(String(entry.tool)), input: (entry.args as Record<string, unknown>) ?? {} }], stop: 'tool_use', usage, model: 'scripted' };
      if (entry && 'output' in entry) return { content: [{ type: 'tool_use', id, name: SUBMIT_TOOL, input: fill(entry.output) as Record<string, unknown> }], stop: 'tool_use', usage, model: 'scripted' };
      return { content: [{ type: 'text', text: String(entry?.text ?? '') }], stop: 'end', usage, model: 'scripted' };
    },
  };
}

/** The tool through which the agent returns its structured output. */
export const SUBMIT_TOOL = 'submit_output';

/** Provider tool names allow [a-zA-Z0-9_-] only: `ci.list-runs@1` becomes `ci_list-runs_1`. */
export function toolName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
