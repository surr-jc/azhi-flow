import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeStep } from './fake-anthropic.js';

/**
 * A scripted stand-in for the OpenAI Responses API (streaming), which is what the Codex CLI
 * speaks. The step index is the number of function calls already answered in the request's
 * input; a tool step matches the end of an offered function name. `{{chunk:N}}` becomes the Nth
 * excerpt ID shown in the first user message. Used by the Codex adapter's tests; never a real model.
 */
export interface FakeResponsesRequest {
  model: string;
  tools: string[];
  instructions: string;
  input: Array<Record<string, any>>;
  body: Record<string, any>;
}

export async function startFakeOpenAIResponses(o: { script: FakeStep[] | ((req: FakeResponsesRequest) => FakeStep[]); delayMs?: number; usage?: { input: number; output: number } }) {
  const requests: FakeResponsesRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const b = raw ? JSON.parse(raw) : {};
      const input = (Array.isArray(b.input) ? b.input : []) as Array<Record<string, any>>;
      const r: FakeResponsesRequest = {
        model: b.model,
        tools: (b.tools ?? []).map((t: { name?: string }) => t.name ?? ''),
        instructions: String(b.instructions ?? ''),
        input,
        body: b,
      };
      if (!req.url?.endsWith('/responses')) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      requests.push(r);
      if (o.delayMs) await new Promise((x) => setTimeout(x, o.delayMs));
      const script = typeof o.script === 'function' ? o.script(r) : o.script;
      const turn = input.filter((i) => i.type === 'function_call_output').length;
      const step = script[Math.min(turn, script.length - 1)] ?? { text: '' };
      const shown = [...JSON.stringify(input).matchAll(/\[(c_[0-9a-f]{20})\]/g)].map((m) => m[1]!);
      const fill = (v: unknown): unknown =>
        typeof v === 'string' ? v.replace(/\{\{chunk:(\d+)\}\}/g, (_, n) => shown[Number(n)] ?? 'c_00000000000000000000') : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
      const usage = o.usage ?? { input: 100, output: 20 };
      const id = `resp_${requests.length}`;
      const item =
        'tool' in step
          ? { type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: r.tools.find((t) => t === step.tool || t.endsWith(`_${step.tool}`)) ?? step.tool, arguments: JSON.stringify(fill(step.input)), status: 'completed' }
          : { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let seq = 0;
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      const base = { id, object: 'response', model: r.model, status: 'in_progress', output: [] };
      ev('response.created', { response: base });
      ev('response.output_item.added', { output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }), status: 'in_progress' } });
      ev('response.output_item.done', { output_index: 0, item });
      ev('response.completed', {
        response: { ...base, status: 'completed', output: [item], usage: { input_tokens: usage.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.input + usage.output } },
      });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
