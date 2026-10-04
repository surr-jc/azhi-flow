import { createRemoteJWKSet, jwtVerify } from 'jose';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../db/schema.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { hashApiToken, newApiToken, verifyRunToken, type RunTokenClaims } from '../security/tokens.js';
import type { AppContext } from '../server/context.js';

export type Principal =
  | { kind: 'user'; workspaceId: string; userId: string; role: Role }
  | { kind: 'run'; workspaceId: string; claims: RunTokenClaims };

const RANK: Record<Role, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };

export function requireRole(p: Principal, min: Role, also?: Role[]): asserts p is Extract<Principal, { kind: 'user' }> {
  if (p.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'this endpoint needs a user or worker token');
  if (RANK[p.role] >= RANK[min] || also?.includes(p.role)) return;
  throw new AzhiError(ErrorClass.authorization, `requires role ${min} or higher (you are ${p.role})`);
}

export const LOCAL_WORKSPACE = 'ws_default';
export const LOCAL_USER = 'usr_local';

/**
 * Local single-user mode: one workspace and one owner, authenticated with an API token written
 * to the data directory (0600) on first start. Still authenticated; never open.
 */
export async function bootstrapLocal(ctx: AppContext): Promise<{ token?: string; tokenFile: string }> {
  await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,'default') ON CONFLICT DO NOTHING`, [LOCAL_WORKSPACE]);
  await ctx.pool.query(`INSERT INTO users(id, workspace_id, display_name, role) VALUES ($1,$2,'local owner','owner') ON CONFLICT DO NOTHING`, [LOCAL_USER, LOCAL_WORKSPACE]);
  const tokenFile = join(ctx.settings.dataDir, 'local-token');
  const existing = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined;
  if (existing) {
    const ok = await ctx.pool.query(`SELECT 1 FROM api_tokens WHERE token_hash=$1 AND revoked_at IS NULL`, [hashApiToken(existing)]);
    if (ok.rowCount) return { tokenFile };
  }
  const { token, hash } = newApiToken();
  await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,'local',$4)`, [newId('tok'), LOCAL_WORKSPACE, LOCAL_USER, hash]);
  mkdirSync(ctx.settings.dataDir, { recursive: true });
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return { token, tokenFile };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function authenticate(ctx: AppContext, header: string | undefined): Promise<Principal> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) throw new AzhiError(ErrorClass.authorization, 'missing bearer token');

  if (token.startsWith('azr.')) {
    const claims = verifyRunToken(ctx.secretKey, token);
    if (!claims) throw new AzhiError(ErrorClass.authorization, 'invalid or expired run token');
    return { kind: 'run', workspaceId: claims.ws, claims };
  }

  if (token.startsWith('azhi_')) {
    const r = await ctx.pool.query(
      `SELECT t.workspace_id, u.id AS user_id, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL`,
      [hashApiToken(token)],
    );
    const row = r.rows[0];
    if (!row) throw new AzhiError(ErrorClass.authorization, 'invalid API token');
    return { kind: 'user', workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
  }

  if (ctx.settings.authMode !== 'oidc' || !ctx.settings.oidcIssuer) throw new AzhiError(ErrorClass.authorization, 'unrecognised token');
  const issuer = ctx.settings.oidcIssuer;
  if (!jwks) {
    const meta = (await (await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: ctx.settings.oidcAudience }).catch((e) => {
    throw new AzhiError(ErrorClass.authorization, `invalid OIDC token: ${(e as Error).message}`);
  });
  const workspaceId = (process.env.AZHI_OIDC_WORKSPACE ?? LOCAL_WORKSPACE) as string;
  await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [workspaceId]);
  const found = await ctx.pool.query(`SELECT id, role FROM users WHERE workspace_id=$1 AND oidc_issuer=$2 AND oidc_subject=$3`, [workspaceId, issuer, payload.sub]);
  if (found.rows[0]) return { kind: 'user', workspaceId, userId: found.rows[0].id, role: found.rows[0].role };
  // First OIDC user of a workspace becomes its owner; later users start as viewers.
  const anyUser = await ctx.pool.query(`SELECT 1 FROM users WHERE workspace_id=$1 AND oidc_subject IS NOT NULL LIMIT 1`, [workspaceId]);
  const role: Role = anyUser.rowCount ? 'viewer' : 'owner';
  const id = newId('usr');
  await ctx.pool.query(`INSERT INTO users(id, workspace_id, email, display_name, oidc_issuer, oidc_subject, role) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id,
    workspaceId,
    payload.email ?? null,
    payload.name ?? null,
    issuer,
    payload.sub,
    role,
  ]);
  return { kind: 'user', workspaceId, userId: id, role };
}
