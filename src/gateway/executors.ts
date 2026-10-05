import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { checkEgress } from './egress.js';
import { SendError } from './ledger.js';
import { ciRuns, commentOnPullRequest, findPullRequestComment, flakyTests, incidents, issue, pullRequest, type GithubConfig } from './tools/github.js';
import { findByDedupeKey, postMessage } from './tools/slack.js';
import { normalizeTicket } from './tools/tickets.js';
import type { ToolSpec } from './types.js';

export interface ExecContext {
  /** Resolved credential value (never logged, never stored in run state). */
  credential?: string;
  idempotencyKey?: string;
  timeoutMs: number;
  slackApiUrl?: string;
}

export interface ExecResult {
  value: unknown;
  /** Source metadata for as-of records. */
  etag?: string;
}

export interface ToolExecutor {
  call(spec: ToolSpec, args: Record<string, unknown>, ctx: ExecContext): Promise<ExecResult>;
  /** write-dedupable tools: look a write up on the target by its dedupe key. */
  lookup?(spec: ToolSpec, args: Record<string, unknown>, key: string, since: Date, ctx: ExecContext): Promise<ExecResult | null>;
}

const githubConfig = (spec: ToolSpec): GithubConfig => ((spec.transport as { config?: GithubConfig }).config ?? {});

const builtin: Record<string, ToolExecutor> = {
  /** Returns data recorded in the registration. Used for fixtures, demos and test-node. */
  fixture: {
    async call(spec) {
      const cfg = (spec.transport as { config?: { data?: unknown } }).config ?? {};
      return { value: structuredClone(cfg.data ?? null) };
    },
  },
  /** Real data for the flagship: GitHub Actions runs and issues (src/gateway/tools/github.ts). */
  'github.ci-runs': {
    async call(spec, args, ctx) {
      return { value: await ciRuns(githubConfig(spec), { since: typeof args.since === 'string' ? args.since : undefined }, ctx.credential, ctx.timeoutMs) };
    },
  },
  'github.flaky-tests': {
    async call(spec, _args, ctx) {
      return { value: await flakyTests(githubConfig(spec), ctx.credential, ctx.timeoutMs) };
    },
  },
  'github.incidents': {
    async call(spec, _args, ctx) {
      return { value: await incidents(githubConfig(spec), ctx.credential, ctx.timeoutMs) };
    },
  },
  /** The pull request review example: one PR's metadata and files, and a comment on it. */
  'github.pull-request': {
    async call(spec, args, ctx) {
      return { value: await pullRequest(githubConfig(spec), args, ctx.credential, ctx.timeoutMs) };
    },
  },
  'github.pr-comment': {
    async call(spec, args, ctx) {
      return { value: await commentOnPullRequest(githubConfig(spec), args, ctx.credential, ctx.idempotencyKey ?? '', ctx.timeoutMs) };
    },
    async lookup(spec, args, key, _since, ctx) {
      const hit = await findPullRequestComment(githubConfig(spec), args, ctx.credential, key, ctx.timeoutMs);
      return hit ? { value: hit } : null;
    },
  },
  /** The SDLC example's intake: one GitHub issue, and any ticket in the shape its agents read. */
  'github.issue': {
    async call(spec, args, ctx) {
      return { value: await issue(githubConfig(spec), args, ctx.credential, ctx.timeoutMs) };
    },
  },
  'ticket.normalize': {
    async call(_spec, args) {
      return { value: normalizeTicket(args) };
    },
  },
  'slack.post-message': {
    async call(_spec, args, ctx) {
      if (!ctx.credential) throw new AzhiError(ErrorClass.authorization, 'slack.post-message needs a bot token credential');
      try {
        const r = await postMessage(
          { token: ctx.credential, apiUrl: ctx.slackApiUrl },
          { channel: String(args.channel), text: String(args.text ?? ''), blocks: args.blocks, dedupeKey: ctx.idempotencyKey ?? '' },
        );
        return { value: { channel: r.channel, ts: r.ts } };
      } catch (err) {
        const slackError = (err as { slackError?: string }).slackError;
        // Slack API errors are definite: the message was not posted.
        if (slackError) throw new SendError(err instanceof Error ? err.message : String(err), true, slackError.includes('auth') ? ErrorClass.authorization : ErrorClass.invalidInput);
        throw new SendError((err as Error).message, false);
      }
    },
    async lookup(_spec, args, key, since, ctx) {
      const hit = await findByDedupeKey({ token: ctx.credential!, apiUrl: ctx.slackApiUrl }, { channel: String(args.channel), dedupeKey: key, oldest: Math.floor(since.getTime() / 1000) });
      return hit ? { value: hit } : null;
    },
  },
};

const http: ToolExecutor = {
  async call(spec, args, ctx) {
    const t = spec.transport as Extract<ToolSpec['transport'], { kind: 'http' }>;
    const used = new Set<string>();
    const url = new URL(
      t.url.replace(/\{(\w+)\}/g, (_, k: string) => {
        used.add(k);
        return encodeURIComponent(String(args[k] ?? ''));
      }),
    );
    for (const q of t.query ?? []) {
      used.add(q);
      if (args[q] !== undefined) url.searchParams.set(q, String(args[q]));
    }
    await checkEgress(url.toString());
    const body = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
    const headers: Record<string, string> = { accept: 'application/json', ...(t.headers ?? {}) };
    if (ctx.credential) headers.authorization = `Bearer ${ctx.credential}`;
    if (ctx.idempotencyKey) headers['idempotency-key'] = ctx.idempotencyKey;
    const hasBody = t.method !== 'GET' && t.method !== 'DELETE';
    if (hasBody) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, { method: t.method, headers, body: hasBody ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ctx.timeoutMs) });
    } catch (err) {
      throw new SendError(`request failed: ${(err as Error).message}`, false);
    }
    const text = await res.text();
    if (!res.ok) {
      const definite = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      const cls = res.status === 401 || res.status === 403 ? ErrorClass.authorization : definite ? ErrorClass.invalidInput : ErrorClass.transient;
      throw new SendError(`HTTP ${res.status}: ${text.slice(0, 200)}`, definite, cls);
    }
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new AzhiError(ErrorClass.contractViolation, 'response is not valid JSON');
    }
    return { value, etag: res.headers.get('etag') ?? undefined };
  },
};

const mcpStdio: ToolExecutor = {
  async call(spec, args, ctx) {
    const t = spec.transport as Extract<ToolSpec['transport'], { kind: 'mcp-stdio' }>;
    const [command, ...cmdArgs] = t.command;
    // Install-time settings (`{{jira_url}}`) the example install fills in; refuse to start without them.
    const unset = [...new Set([...t.command, ...Object.values(t.env ?? {})].flatMap((v) => [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)))];
    if (unset.length) throw new SendError(`${spec.id} is missing the setting${unset.length > 1 ? 's' : ''} ${unset.join(', ')}: install the example again with ${unset.map((u) => `--set ${u}=...`).join(' ')} (or fill it in on the Examples page)`, true, ErrorClass.invalidInput);
    const credentialEnv = t.credential_env ?? 'AZHI_TOOL_CREDENTIAL';
    if (!/^[A-Z][A-Z0-9_]*$/.test(credentialEnv) || ['PATH', 'HOME'].includes(credentialEnv)) throw new AzhiError(ErrorClass.invalidInput, `${spec.id}: credential_env must be an upper-case variable name other than PATH or HOME`);
    const transport = new StdioClientTransport({
      command: command!,
      args: cmdArgs,
      cwd: t.cwd,
      env: { PATH: process.env.PATH ?? '', ...(t.env ?? {}), ...(ctx.credential ? { [credentialEnv]: ctx.credential } : {}) },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'azhi-gateway', version: '0.1.0' });
    try {
      await client.connect(transport);
      const r = (await client.callTool({ name: t.tool, arguments: args }, undefined, { timeout: ctx.timeoutMs })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (r.isError) throw new SendError(`MCP tool error: ${text.slice(0, 200)}`, true, ErrorClass.invalidInput);
      if (r.structuredContent !== undefined) return { value: r.structuredContent };
      try {
        return { value: JSON.parse(text) };
      } catch {
        return { value: text };
      }
    } finally {
      await client.close().catch(() => {});
    }
  },
};

export function executorFor(spec: ToolSpec): ToolExecutor {
  switch (spec.transport.kind) {
    case 'builtin': {
      const e = builtin[spec.transport.name];
      if (!e) throw new AzhiError(ErrorClass.unsupportedCapability, `unknown builtin transport '${spec.transport.name}'`);
      return e;
    }
    case 'http':
      return http;
    case 'mcp-stdio':
      return mcpStdio;
  }
}

/** Tools every workspace has without registration. */
export const BUILTIN_TOOLS: ToolSpec[] = [
  {
    id: 'slack.post-message',
    version: 1,
    revision: 0,
    description: 'Post a message to a Slack channel. Deduplicated by the ledger action ID in message metadata.',
    effect: 'write-dedupable',
    transport: { kind: 'builtin', name: 'slack.post-message' },
    credential: 'slack-bot-token',
    source: 'slack',
    input_schema: {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string', maxLength: 40000 }, blocks: { type: 'array' } },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' } }, required: ['channel', 'ts'] },
  },
];
