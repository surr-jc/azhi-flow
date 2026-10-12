import type { FastifyInstance, FastifyRequest } from 'fastify';
import { chatgptAuth } from '../agents/chatgpt-auth.js';
import { decryptSecret } from '../security/secrets.js';
import { ghCliToken, parseGhCliPointer } from '../server/gh-cli.js';
import type { AppContext } from '../server/context.js';
import { copilotSignIn } from './copilot.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { requireRole } from './auth.js';

/** How a secret's value was supplied: pointing at the GitHub CLI, an OpenAI or Copilot device sign-in, or a pasted token. */
export type SigninKind = 'gh-cli' | 'chatgpt' | 'copilot' | 'token';

export interface SigninSecret {
  name: string;
  status: 'set' | 'missing';
  kind?: SigninKind;
  version?: number;
  updated_at?: string;
  /** Set when the secret holds a different kind of sign-in than the integration needs. */
  problem?: string;
  /** For a GitHub CLI pointer: whether `gh` hands out a token right now. */
  gh_ok?: boolean;
  host?: string;
}

interface Integration {
  id: string;
  title: string;
  description: string;
  /** The kinds of value these secrets accept; the first is the recommended way. */
  accepts: SigninKind[];
  secrets: string[];
  /** Where the page or CLI starts a sign-in. */
  cli: string;
}

/** The integrations the server knows how to sign in to. Any other secret is listed under "other". */
export const INTEGRATIONS: Integration[] = [
  { id: 'github', title: 'GitHub', description: 'Reading pull requests, cloning repositories, commenting and pushing.', accepts: ['gh-cli', 'token'], secrets: ['github-read-token', 'github-write-token', 'github-comment-token'], cli: 'azhi github login --secret <name...>' },
  { id: 'copilot', title: 'GitHub Copilot', description: 'OpenCode steps on the models of your Copilot subscription.', accepts: ['copilot'], secrets: ['github-copilot-token'], cli: 'azhi copilot login' },
  { id: 'chatgpt', title: 'ChatGPT plan', description: 'OpenCode steps on the OpenAI models of your ChatGPT plan.', accepts: ['chatgpt'], secrets: ['openai-chatgpt-auth'], cli: 'azhi chatgpt login' },
  { id: 'claude-plan', title: 'Claude plan', description: 'Claude Agent SDK steps on your Claude Pro or Max plan (token from `claude setup-token`).', accepts: ['token'], secrets: ['claude-oauth-token'], cli: 'azhi secret set claude-oauth-token' },
  { id: 'anthropic', title: 'Anthropic API', description: 'Steps that call the Anthropic API directly.', accepts: ['token'], secrets: ['anthropic-api-key'], cli: 'azhi secret set anthropic-api-key' },
  { id: 'slack', title: 'Slack', description: 'Posting the review summary to a channel.', accepts: ['token'], secrets: ['slack-bot-token'], cli: 'azhi secret set slack-bot-token' },
  { id: 'jira', title: 'Jira', description: 'Reading and updating Jira issues.', accepts: ['token'], secrets: ['jira-api-token'], cli: 'azhi secret set jira-api-token' },
];

const KIND_LABEL: Record<SigninKind, string> = { 'gh-cli': 'GitHub CLI login', chatgpt: 'ChatGPT sign-in', copilot: 'GitHub Copilot sign-in', token: 'a pasted token' };

/** What kind of value this is. Never returns or logs the value itself. */
export function classifySecret(value: string): { kind: SigninKind; host?: string } {
  const pointer = parseGhCliPointer(value);
  if (pointer) return { kind: 'gh-cli', host: pointer.host };
  if (chatgptAuth(value)) return { kind: 'chatgpt' };
  if (value.trim().startsWith('{')) {
    try {
      copilotSignIn(value);
      return { kind: 'copilot' };
    } catch {
      // JSON that is not a Copilot sign-in: report it as a token, and the integration check says why it does not fit.
    }
  }
  return { kind: 'token' };
}

/** Why a secret of this kind does not suit the integration, or undefined when it does. */
export function mismatch(accepts: SigninKind[], kind: SigninKind, name: string): string | undefined {
  if (accepts.includes(kind)) return undefined;
  const wanted = accepts.map((k) => KIND_LABEL[k]).join(' or ');
  return `${name} holds ${KIND_LABEL[kind]}, but this integration needs ${wanted}.`;
}

function user(req: FastifyRequest) {
  if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
  return req.principal;
}

export async function signinStatus(ctx: AppContext, workspaceId: string) {
  // The newest version of every secret, decrypted only to classify it.
  const rows = (
    await ctx.pool.query(
      `SELECT DISTINCT ON (name) name, version, ciphertext, created_at FROM secrets WHERE workspace_id=$1 ORDER BY name, version DESC`,
      [workspaceId],
    )
  ).rows as Array<{ name: string; version: number; ciphertext: Buffer | string; created_at: Date }>;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const ghChecks = new Map<string, Promise<boolean>>();
  const ghOk = (host: string) => {
    if (!ghChecks.has(host)) ghChecks.set(host, ghCliToken(host).then(() => true, () => false));
    return ghChecks.get(host)!;
  };

  const describe = async (name: string, accepts?: SigninKind[]): Promise<SigninSecret> => {
    const row = byName.get(name);
    if (!row) return { name, status: 'missing' };
    const { kind, host } = classifySecret(decryptSecret(ctx.secretKey, row.ciphertext as Buffer));
    return {
      name,
      status: 'set',
      kind,
      version: row.version,
      updated_at: new Date(row.created_at).toISOString(),
      ...(host ? { host, gh_ok: await ghOk(host) } : {}),
      ...(accepts ? { problem: mismatch(accepts, kind, name) } : {}),
    };
  };

  const integrations = [];
  for (const i of INTEGRATIONS) {
    integrations.push({ id: i.id, title: i.title, description: i.description, accepts: i.accepts, cli: i.cli, secrets: await Promise.all(i.secrets.map((n) => describe(n, i.accepts))) });
  }
  const known = new Set(INTEGRATIONS.flatMap((i) => i.secrets));
  const other = await Promise.all(rows.filter((r) => !known.has(r.name)).map((r) => describe(r.name)));
  return { integrations, other };
}

/**
 * One view of every sign-in the workspace has: which integration each secret serves, how it was
 * supplied, and whether it suits the integration. Values never leave the server.
 */
export function registerSigninRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/v1/signins', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    return signinStatus(ctx, p.workspaceId);
  });
}
