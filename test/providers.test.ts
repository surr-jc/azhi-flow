import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { anthropicProvider, toolName } from '../src/agents/providers.js';
import { estimateCost } from '../src/agents/model-agent.js';

describe('anthropic provider', () => {
  it('maps the request, tool calls and usage; unknown usage stays null', async () => {
    let seen: any;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(body), url: req.url };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'm-test',
            stop_reason: 'tool_use',
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'tool_use', id: 't1', name: 'ci_list-runs_1', input: { team: 'x' } },
            ],
            usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const p = anthropicProvider({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'k' });
      const r = await p.complete({ model: 'm-test', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 50 });
      expect(seen.url).toBe('/v1/messages');
      expect(seen.headers['x-api-key']).toBe('k');
      expect(seen.body.system[0]).toMatchObject({ text: 'sys', cache_control: { type: 'ephemeral' } });
      expect(seen.body.max_tokens).toBe(50);
      expect(r.stop).toBe('tool_use');
      expect(r.content).toEqual([{ type: 'tool_use', id: 't1', name: 'ci_list-runs_1', input: { team: 'x' } }]);
      expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 30, cache_read_tokens: 100, cache_write_tokens: null, reasoning_tokens: null });
    } finally {
      server.close();
    }
  });

  it('classifies HTTP errors', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const p = anthropicProvider({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'k' });
      await expect(p.complete({ model: 'm', system: '', messages: [], tools: [], maxTokens: 1 })).rejects.toMatchObject({ errorClass: 'authorization' });
    } finally {
      server.close();
    }
  });

  it('names tools within provider limits and estimates cost only from declared pricing', () => {
    expect(toolName('ci.list-runs@1')).toBe('ci_list-runs_1');
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null };
    expect(estimateCost(u, undefined)).toBeNull();
    expect(estimateCost(u, { currency: 'USD', input_per_mtok: 2, output_per_mtok: 10, revision: 'r' })).toBe(12);
    expect(estimateCost({ ...u, output_tokens: null }, { currency: 'USD', input_per_mtok: 2, output_per_mtok: 10, revision: 'r' })).toBeNull();
  });
});
