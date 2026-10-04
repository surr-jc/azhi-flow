import http from 'node:http';

export interface FakeSlackMessage {
  ts: string;
  channel: string;
  text: string;
  blocks?: unknown;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

/**
 * A minimal stand-in for the Slack Web API: `chat.postMessage` and `conversations.history`
 * (with `include_all_metadata`). Used by tests, the recovery suite and local demos so that
 * Slack delivery can be exercised without a workspace. Point `AZHI_SLACK_API_URL` at it.
 */
export async function startFakeSlack(port = 0, opts: { token?: string } = {}) {
  const messages: FakeSlackMessage[] = [];
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = url.pathname.replace(/^\/(api\/)?/, '');
    const send = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send({ ok: false, error: 'invalid_auth' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const params: Record<string, any> = Object.fromEntries(url.searchParams);
    if (raw) Object.assign(params, req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)));

    if (method === 'chat.postMessage') {
      if (!params.channel) return send({ ok: false, error: 'channel_not_found' });
      const ts = `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, '0')}`;
      messages.push({ ts, channel: params.channel, text: params.text ?? '', blocks: params.blocks, metadata: params.metadata });
      return send({ ok: true, channel: params.channel, ts });
    }
    if (method === 'conversations.history') {
      const includeMeta = String(params.include_all_metadata) === 'true';
      const oldest = params.oldest ? Number(params.oldest) : 0;
      const found = messages
        .filter((m) => m.channel === params.channel && Number(m.ts) >= oldest)
        .reverse()
        .map((m) => ({ type: 'message', ts: m.ts, text: m.text, ...(includeMeta && m.metadata ? { metadata: m.metadata } : {}) }));
      return send({ ok: true, messages: found, has_more: false });
    }
    if (method === 'auth.test') return send({ ok: true, team: 'fake', user: 'azhi-bot' });
    res.statusCode = 404;
    send({ ok: false, error: 'unknown_method' });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    messages,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
