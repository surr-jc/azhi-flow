import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeStep } from './fake-anthropic.js';

/**
 * A scripted stand-in for the OpenAI Chat Completions API, playing the same steps as the fake
 * Anthropic endpoint: the step index is the number of assistant messages so far, and a tool step
 * matches the end of an offered function name. `{{chunk:N}}` becomes the Nth excerpt ID shown in
 * the first user message. Used by tests, the comparison and the demo; never a real model.
 */
export interface FakeOpenAIRequest {
  model: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  tools: string[];
  system: string;
  messages: Array<Record<string, any>>;
  body: Record<string, any>;
}

export async function startFakeOpenAI(o: { script: FakeStep[] | ((req: FakeOpenAIRequest) => FakeStep[]); usage?: { input: number; output: number }; bearer?: string; models?: string[]; modelEntries?: Array<Record<string, unknown>> }) {
  const requests: FakeOpenAIRequest[] = [];
  let bearer = o.bearer;
  let chatOnly = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').split('?')[0]!.endsWith('/models')) {
        // The model list a sign-in is checked with.
        if (bearer && !chatOnly && req.headers.authorization !== `Bearer ${bearer}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ data: o.modelEntries ?? (o.models ?? []).map((id) => ({ id })) }));
      }
      const b = raw ? JSON.parse(raw) : {};
      const messages = (b.messages ?? []) as Array<Record<string, any>>;
      const r: FakeOpenAIRequest = {
        model: b.model,
        url: req.url ?? '',
        headers: req.headers,
        tools: (b.tools ?? []).map((t: { function: { name: string } }) => t.function.name),
        system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
        messages,
        body: b,
      };
      requests.push(r);
      // As Copilot answers a sign-in it does not accept.
      if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }));
      }
      const script = typeof o.script === 'function' ? o.script(r) : o.script;
      const turn = messages.filter((m) => m.role === 'assistant').length;
      const step = script[Math.min(turn, script.length - 1)] ?? { text: '' };
      const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
      const shown = [...String(firstUser).matchAll(/\[(c_[0-9a-f]{20})\]/g)].map((m) => m[1]!);
      const fill = (v: unknown): unknown =>
        typeof v === 'string' ? v.replace(/\{\{chunk:(\d+)\}\}/g, (_, n) => shown[Number(n)] ?? 'c_00000000000000000000') : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
      const usage = o.usage ?? { input: 100, output: 20 };
      const message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } =
        'tool' in step
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${turn + 1}`, type: 'function', function: { name: r.tools.find((t) => t === step.tool || t.endsWith(`_${step.tool}`)) ?? step.tool, arguments: JSON.stringify(fill(step.input)) } }] }
          : { role: 'assistant', content: step.text };
      if (b.stream) {
        // Streaming (what OpenCode's OpenAI-compatible providers ask for): one chunk with the message, then usage.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null, extra: object = {}) =>
          res.write(`data: ${JSON.stringify({ id: `chatcmpl_${turn}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        chunk({ role: 'assistant', content: '' }, null);
        if ('tool' in step) chunk({ tool_calls: message.tool_calls!.map((c, index) => ({ index, ...c })) }, null);
        else chunk({ content: step.text }, null);
        chunk({}, 'tool' in step ? 'tool_calls' : 'stop');
        res.write(`data: ${JSON.stringify({ id: `chatcmpl_${turn}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.model, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `chatcmpl_${turn}`,
          object: 'chat.completion',
          model: r.model,
          choices: [{ index: 0, message, finish_reason: 'tool' in step ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    requireBearer: (v?: string, onlyChat = false) => {
      bearer = v;
      chatOnly = onlyChat;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
