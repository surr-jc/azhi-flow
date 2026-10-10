import http from 'node:http';

export interface FakeSlackMessage {
  ts: string;
  channel: string;
  text: string;
  blocks?: unknown;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

/**
 * A minimal stand-in for the Slack Web API: `chat.postMessage`, `views.open` and
 * `conversations.history` (with `include_all_metadata`). Used by tests, the recovery suite and local demos so that
 * Slack delivery can be exercised without a workspace. Point `AZHI_SLACK_API_URL` at it.
 */
export async function startFakeSlack(port = 0, opts: { token?: string; postDelayMs?: number; host?: string } = {}) {
  const messages: FakeSlackMessage[] = [];
  // Bodies posted to interaction response URLs (`<url>/response/<id>`).
  const responses: Array<Record<string, unknown>> = [];
  // Modals opened with `views.open` (a button click's `trigger_id` plus the view).
  const views: Array<{ trigger_id: string; view: any }> = [];
  const state = { postDelayMs: opts.postDelayMs ?? 0 };
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
      // The message is posted before the response is sent: a crash in this window is
      // exactly the "sent, no receipt" case the ledger must reconcile.
      if (state.postDelayMs) await new Promise((r) => setTimeout(r, state.postDelayMs));
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
    if (method === 'views.open') {
      if (!params.trigger_id) return send({ ok: false, error: 'invalid_trigger_id' });
      views.push({ trigger_id: params.trigger_id, view: params.view });
      return send({ ok: true, view: { id: `V${views.length}` } });
    }
    if (method.startsWith('response/')) {
      responses.push(params);
      return send({ ok: true });
    }
    if (method === 'auth.test') return send({ ok: true, team: 'fake', user: 'azhi-bot' });
    res.statusCode = 404;
    send({ ok: false, error: 'unknown_method' });
  });
  await new Promise<void>((r) => server.listen(port, opts.host ?? '127.0.0.1', r));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    messages,
    responses,
    views,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
