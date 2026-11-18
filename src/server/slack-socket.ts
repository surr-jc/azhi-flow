import type { FastifyInstance } from 'fastify';
import { SLACK_COMMANDS, SLACK_EVENTS, SLACK_INTERACTIONS, signSlackRequest } from '../api/slack.js';
import type { AppContext } from './context.js';
import { resolveSecret } from './secrets.js';

/**
 * Slack Socket Mode (docs/slack-assistant.md): Slack is reached over an outbound websocket, so no public URL is
 * needed. Each envelope becomes a request to the same route the webhook uses, signed with the workspace's own
 * signing secret, so the handlers and their signature check are the ones that already exist. The app-level
 * token (`slack-app-token`) only authenticates the connection.
 */
export const SLACK_APP_TOKEN_SECRET = 'slack-app-token';

/** The part of a WebSocket this module uses, so tests can inject a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
}

export interface SlackSocketOptions {
  connect?: (url: string) => SocketLike;
  /** How often workspaces are re-scanned. */
  scanMs?: number;
  /** Reconnect delays: first and longest. */
  backoffMs?: { min: number; max: number };
  /** A connection that lasted this long resets the backoff. */
  stableMs?: number;
}

interface Conn {
  token: string;
  secret: string;
  socket?: SocketLike;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  delay: number;
  openedAt?: number;
  /** Slack asked for a reconnect: skip the backoff. */
  immediate?: boolean;
}

interface Envelope {
  envelope_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
  retry_attempt?: number;
}

export function startSlackSocketMode(ctx: AppContext, app: FastifyInstance, log: (m: string) => void, opts: SlackSocketOptions = {}): () => void {
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const backoff = opts.backoffMs ?? { min: 1000, max: 30_000 };
  const stableMs = opts.stableMs ?? 30_000;
  const apiUrl = ctx.settings.slackApiUrl ?? 'https://slack.com/api';
  const conns = new Map<string, Conn>();
  let stopped = false;

  const drop = (ws: string, c: Conn) => {
    c.stopped = true;
    if (c.timer) clearTimeout(c.timer);
    const s = c.socket;
    c.socket = undefined;
    try {
      s?.close();
    } catch {
      // Already closed.
    }
    conns.delete(ws);
  };

  /** Turns one envelope into a signed request to our own route. The payload is Slack's, and stays data. */
  const handle = async (c: Conn, sock: SocketLike, env: Envelope) => {
    const id = env.envelope_id;
    if (!id) return;
    const ack = (payload?: unknown) => {
      try {
        sock.send(JSON.stringify(payload === undefined ? { envelope_id: id } : { envelope_id: id, payload }));
      } catch {
        // The socket closed; Slack redelivers.
      }
    };
    const p = env.payload ?? {};
    let url: string;
    let type: string;
    let body: string;
    if (env.type === 'events_api') {
      url = SLACK_EVENTS;
      type = 'application/json';
      body = JSON.stringify(p);
    } else if (env.type === 'slash_commands') {
      url = SLACK_COMMANDS;
      type = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v ?? '')])).toString();
    } else if (env.type === 'interactive') {
      url = SLACK_INTERACTIONS;
      type = 'application/x-www-form-urlencoded';
      body = `payload=${encodeURIComponent(JSON.stringify(p))}`;
    } else {
      log(`slack socket: ignored envelope type ${String(env.type).slice(0, 40)}`);
      ack();
      return;
    }
    const headers: Record<string, string> = { 'content-type': type, ...signSlackRequest(c.secret, body) };
    if ((env.retry_attempt ?? 0) > 0) headers['x-slack-retry-num'] = String(env.retry_attempt);
    // Slack wants the acknowledgement within 3 seconds, so slow work comes after it. A command's route only
    // starts the run in the background, so its quick answer is what the ack carries.
    if (env.type !== 'slash_commands') ack();
    try {
      const r = await app.inject({ method: 'POST', url, headers, payload: body });
      const evType = env.type === 'events_api' && typeof (p.event as { type?: unknown } | undefined)?.type === 'string' ? ` ${(p.event as { type: string }).type.slice(0, 40)}` : '';
      log(`slack socket: ${env.type}${evType} -> ${r.statusCode}`);
      if (env.type !== 'slash_commands') return;
      let reply: unknown;
      try {
        reply = JSON.parse(r.body);
      } catch {
        // No JSON reply.
      }
      const o = reply as { response_type?: unknown; text?: unknown } | undefined;
      ack(r.statusCode === 200 && o && typeof o.response_type === 'string' && typeof o.text === 'string' ? { response_type: o.response_type, text: o.text } : undefined);
    } catch (e) {
      if (env.type === 'slash_commands') ack();
      log(`slack socket: handling ${env.type} failed: ${(e as Error).message}`);
    }
  };

  const open = async (ws: string, c: Conn) => {
    if (c.stopped) return;
    try {
      const res = await fetch(`${apiUrl}/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${c.token}` } });
      const j = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!j.ok || !j.url) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (c.stopped) return;
      const sock = connect(j.url);
      c.socket = sock;
      sock.addEventListener('open', () => {
        if (c.socket !== sock) return;
        c.openedAt = Date.now();
        log(`slack socket: connected (workspace ${ws})`);
      });
      sock.addEventListener('message', (ev: { data: unknown }) => {
        if (c.socket !== sock) return;
        let env: Envelope & { type?: string };
        try {
          env = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (env.type === 'hello') return;
        if (env.type === 'disconnect') {
          // Slack is rotating the connection: come back at once with a fresh url.
          c.immediate = true;
          try {
            sock.close();
          } catch {
            // Already closed.
          }
          return;
        }
        void handle(c, sock, env);
      });
      sock.addEventListener('error', () => {
        // A failed connection also closes; reconnecting happens there.
      });
      sock.addEventListener('close', () => {
        if (c.socket !== sock) return;
        c.socket = undefined;
        if (c.stopped) return;
        if (c.openedAt && Date.now() - c.openedAt >= stableMs) c.delay = backoff.min;
        c.openedAt = undefined;
        const wait = c.immediate ? 0 : c.delay;
        if (!c.immediate) c.delay = Math.min(c.delay * 2, backoff.max);
        c.immediate = false;
        log(`slack socket: disconnected (workspace ${ws}); reconnecting in ${wait}ms`);
        c.timer = setTimeout(() => void open(ws, c), wait);
      });
    } catch (e) {
      if (c.stopped) return;
      log(`slack socket: connection failed (workspace ${ws}): ${(e as Error).message}; retrying in ${c.delay}ms`);
      c.timer = setTimeout(() => void open(ws, c), c.delay);
      c.delay = Math.min(c.delay * 2, backoff.max);
    }
  };

  const scan = async () => {
    if (stopped) return;
    try {
      const rows = (await ctx.pool.query(`SELECT id FROM workspaces WHERE settings->'slack_commands'->>'enabled' = 'true' OR settings->'slack_assistant'->>'enabled' = 'true'`)).rows as Array<{ id: string }>;
      const wanted = new Set<string>();
      for (const { id } of rows) {
        const token = await resolveSecret(ctx, id, SLACK_APP_TOKEN_SECRET);
        const secret = await resolveSecret(ctx, id, 'slack-signing-secret');
        if (!token || !secret) continue;
        wanted.add(id);
        const have = conns.get(id);
        if (have && have.token === token.value && have.secret === secret.value) continue;
        if (have) drop(id, have);
        if (stopped) return;
        const c: Conn = { token: token.value, secret: secret.value, stopped: false, delay: backoff.min };
        conns.set(id, c);
        void open(id, c);
      }
      for (const [id, c] of [...conns]) if (!wanted.has(id)) drop(id, c);
    } catch (e) {
      log(`slack socket: scan failed: ${(e as Error).message}`);
    }
  };

  void scan();
  const timer = setInterval(() => void scan(), opts.scanMs ?? 30_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const [id, c] of [...conns]) drop(id, c);
  };
}
