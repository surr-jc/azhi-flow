import { AzhiError, ErrorClass } from '../lib/errors.js';
import type { Settings } from '../config/settings.js';
import type { ScriptedTurn } from './profile.js';

/**
 * Provider-neutral transcript blocks. They map one to one onto the Anthropic Messages API; the
 * OpenAI adapter translates them to and from Chat Completions messages.
 */
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

/** fetch, with the network cause in the error: undici's own message is only "fetch failed". */
async function post(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
    throw new AzhiError(ErrorClass.transient, `cannot reach ${new URL(url).host}: ${detail || (err as Error).message}`);
  }
}

export const UNKNOWN_USAGE: Usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null };

/** Anthropic Messages API. The stable system prompt is marked for prefix caching. */
export function anthropicProvider(o: { apiUrl: string; apiKey: string }): ModelProvider {
  return {
    id: 'anthropic',
    async complete(req) {
      const res = await post(`${o.apiUrl.replace(/\/$/, '')}/v1/messages`, {
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
      if (!res.ok) throw httpError('anthropic', res.status, body?.error?.message ?? text.slice(0, 200));
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

/** Server-side defaults per provider: the model for `name: default`, the API URL, the credential. */
export const PROVIDER_DEFAULTS = {
  anthropic: { credential: 'anthropic-api-key', modelEnv: 'AZHI_ANTHROPIC_MODEL', model: (s: Settings) => s.anthropicModel, apiUrl: (s: Settings) => s.anthropicApiUrl },
  openai: { credential: 'openai-api-key', modelEnv: 'AZHI_OPENAI_MODEL', model: (s: Settings) => s.openaiModel, apiUrl: (s: Settings) => s.openaiApiUrl },
  // GitHub Copilot models, driven by OpenCode only: the credential is a Copilot sign-in (a GitHub OAuth token,
  // see src/api/copilot.ts); the API URL is empty for Copilot's own endpoint and set only for tests or proxies.
  'github-copilot': { credential: 'github-copilot-token', modelEnv: 'AZHI_COPILOT_MODEL', model: (s: Settings) => s.copilotModel, apiUrl: (s: Settings) => s.copilotApiUrl ?? '' },
} as const;
export type HostedProvider = keyof typeof PROVIDER_DEFAULTS;

function httpError(provider: string, status: number, message: string): AzhiError {
  const m = `${provider} HTTP ${status}: ${message}`;
  if (status === 401 || status === 403) return new AzhiError(ErrorClass.authorization, m);
  if (status === 400 || status === 404) return new AzhiError(ErrorClass.invalidInput, m);
  return new AzhiError(ErrorClass.transient, m);
}

/**
 * OpenAI Chat Completions (also served by OpenAI-compatible gateways at the same path). Tool
 * calls map to `tool_use` blocks and tool results to `tool` messages. Cached and reasoning tokens
 * are recorded when the response reports them and are null otherwise.
 */
export interface OpenAIOptions {
  apiUrl: string;
  apiKey: string;
  /** The provider name in errors; default openai. */
  id?: string;
  /** The path under apiUrl; default /v1/chat/completions (/v1/responses for the Responses API). */
  path?: string;
  /** Extra headers per request (Copilot wants OpenCode's). */
  headers?: (req: ModelRequest) => Record<string, string>;
  /** Chat Completions only: Copilot takes max_tokens; OpenAI itself wants max_completion_tokens. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
}

export function openaiProvider(o: OpenAIOptions): ModelProvider {
  const id = o.id ?? 'openai';
  return {
    id,
    async complete(req) {
      const messages: unknown[] = [{ role: 'system', content: req.system }];
      for (const m of req.messages) {
        const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
        if (m.role === 'assistant') {
          const calls = m.content.filter((b) => b.type === 'tool_use') as Array<Extract<Block, { type: 'tool_use' }>>;
          messages.push({
            role: 'assistant',
            content: text || null,
            ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
          });
          continue;
        }
        for (const b of m.content) if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
        if (text) messages.push({ role: 'user', content: text });
      }
      const res = await post(`${o.apiUrl.replace(/\/$/, '')}${o.path ?? '/v1/chat/completions'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}`, ...o.headers?.(req) },
        body: JSON.stringify({
          model: req.model,
          [o.maxTokensParam ?? 'max_completion_tokens']: req.maxTokens,
          messages,
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
        signal: req.signal,
      });
      const raw = await res.text();
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AzhiError(ErrorClass.transient, `${id} returned HTTP ${res.status} with a non-JSON body`);
      }
      if (!res.ok) throw httpError(id, res.status, body?.error?.message ?? raw.slice(0, 200));
      // Copilot's Claude models can split one answer over several choices (text in one, tool calls in another).
      const choices = (body.choices ?? []) as any[];
      const choice = choices[0];
      if (!choice) throw new AzhiError(ErrorClass.transient, `${id} returned no choices`);
      const content: Block[] = [];
      for (const ch of choices) if (typeof ch.message?.content === 'string' && ch.message.content) content.push({ type: 'text', text: ch.message.content });
      for (const c of choices.flatMap((ch) => ch.message?.tool_calls ?? [])) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(c.function?.arguments || '{}');
        } catch {
          // Invalid JSON goes to the schema check like any other bad output, so the agent can repair it.
          input = { _invalid_json: String(c.function?.arguments ?? '') };
        }
        content.push({ type: 'tool_use', id: c.id, name: c.function?.name ?? '', input });
      }
      const u = body.usage ?? {};
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        content,
        stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : choices.some((ch) => ch.finish_reason === 'length') ? 'max_tokens' : 'end',
        usage: {
          input_tokens: num(u.prompt_tokens),
          output_tokens: num(u.completion_tokens),
          cache_read_tokens: num(u.prompt_tokens_details?.cached_tokens),
          cache_write_tokens: null,
          reasoning_tokens: num(u.completion_tokens_details?.reasoning_tokens),
        },
        model: body.model ?? req.model,
      };
    },
  };
}

/**
 * The OpenAI Responses API, for models served only there (Copilot's GPT-5 and Codex models, for
 * one). Stateless (`store: false`): the whole transcript goes with each request, tool calls as
 * `function_call` items and results as `function_call_output` items.
 */
export function responsesProvider(o: OpenAIOptions): ModelProvider {
  const id = o.id ?? 'openai';
  return {
    id,
    async complete(req) {
      const input: unknown[] = [];
      for (const m of req.messages) {
        const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
        if (m.role === 'assistant') {
          if (text) input.push({ role: 'assistant', content: text });
          for (const b of m.content) if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
          continue;
        }
        for (const b of m.content) if (b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `ERROR: ${b.content}` : b.content });
        if (text) input.push({ role: 'user', content: text });
      }
      const res = await post(`${o.apiUrl.replace(/\/$/, '')}${o.path ?? '/v1/responses'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}`, ...o.headers?.(req) },
        body: JSON.stringify({
          model: req.model,
          instructions: req.system,
          input,
          max_output_tokens: req.maxTokens,
          store: false,
          ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })) } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
        signal: req.signal,
      });
      const raw = await res.text();
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AzhiError(ErrorClass.transient, `${id} returned HTTP ${res.status} with a non-JSON body`);
      }
      if (!res.ok) throw httpError(id, res.status, body?.error?.message ?? raw.slice(0, 200));
      const content: Block[] = [];
      for (const item of (body.output ?? []) as any[]) {
        if (item?.type === 'message') {
          const text = (item.content ?? []).filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string').map((c: any) => c.text).join('');
          if (text) content.push({ type: 'text', text });
        } else if (item?.type === 'function_call') {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(item.arguments || '{}');
          } catch {
            args = { _invalid_json: String(item.arguments ?? '') };
          }
          content.push({ type: 'tool_use', id: String(item.call_id ?? item.id), name: String(item.name ?? ''), input: args });
        }
      }
      const u = body.usage ?? {};
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        content,
        stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end',
        usage: {
          input_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
          cache_read_tokens: num(u.input_tokens_details?.cached_tokens),
          cache_write_tokens: null,
          reasoning_tokens: num(u.output_tokens_details?.reasoning_tokens),
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
