import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted stand-in for the Anthropic Messages API, streaming and non-streaming. Each request
 * plays the script entry at the index of its assistant-message count: a tool call (matched by
 * the end of the tool name, so `submit_output` finds `azhi_submit_output`) or plain text.
 * `{{chunk:N}}` in tool input becomes the Nth excerpt ID in the first user message.
 * Used by the OpenCode conformance suite and the fixture comparison; never a real model.
 */
export type FakeStep = { tool: string; input: Record<string, unknown> } | { text: string };

export interface FakeRequest {
  model: string;
  stream: boolean;
  tools: string[];
  system: string;
  messages: unknown[];
}

export async function startFakeAnthropic(o: { script: FakeStep[] | ((req: FakeRequest) => FakeStep[]); delayMs?: number; usage?: { input: number; output: number } }) {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const b = body ? JSON.parse(body) : {};
      const r: FakeRequest = {
        model: b.model,
        stream: Boolean(b.stream),
        tools: (b.tools ?? []).map((t: { name: string }) => t.name),
        system: typeof b.system === 'string' ? b.system : (b.system ?? []).map((s: { text: string }) => s.text).join('\n'),
        messages: b.messages ?? [],
      };
      requests.push(r);
      if (o.delayMs) await new Promise((x) => setTimeout(x, o.delayMs));
      const script = typeof o.script === 'function' ? o.script(r) : o.script;
      const turn = r.messages.filter((m: any) => m.role === 'assistant').length;
      const step = script[Math.min(turn, script.length - 1)] ?? { text: '' };
      const shown = [...JSON.stringify(r.messages[0] ?? '').matchAll(/\[(c_[0-9a-f]{20})\]/g)].map((m) => m[1]!);
      const fill = (v: unknown): unknown =>
        typeof v === 'string' ? v.replace(/\{\{chunk:(\d+)\}\}/g, (_, n) => shown[Number(n)] ?? 'c_00000000000000000000') : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
      const name = 'tool' in step ? (r.tools.find((t) => t === step.tool || t.endsWith(`_${step.tool}`)) ?? step.tool) : undefined;
      const usage = o.usage ?? { input: 100, output: 20 };
      const block = 'tool' in step ? { type: 'tool_use', id: `toolu_${turn + 1}`, name, input: fill(step.input) } : { type: 'text', text: step.text };
      const stop = 'tool' in step ? 'tool_use' : 'end_turn';
      if (!r.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `msg_${turn}`, type: 'message', role: 'assistant', model: r.model, content: [block], stop_reason: stop, usage: { input_tokens: usage.input, output_tokens: usage.output } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 1 } } });
      if (block.type === 'tool_use') {
        ev('content_block_start', { index: 0, content_block: { ...block, input: {} } });
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      } else {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: (block as { text: string }).text } });
      }
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: usage.output } });
      ev('message_stop', {});
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
