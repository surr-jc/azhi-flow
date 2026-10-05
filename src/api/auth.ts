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

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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
      `SELECT t.workspace_id, u.id AS user_id, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
      [hashApiToken(token)],
    );
    const row = r.rows[0];
    if (!row) throw new AzhiError(ErrorClass.authorization, 'invalid API token');
    return { kind: 'user', workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
  }

  // OIDC bearer tokens are accepted whenever an issuer is configured, alongside API tokens.
  if (!ctx.settings.oidcIssuer) throw new AzhiError(ErrorClass.authorization, 'unrecognised token');
  const issuer = ctx.settings.oidcIssuer;
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    const meta = (await (await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: ctx.settings.oidcAudience }).catch((e) => {
    throw new AzhiError(ErrorClass.authorization, `invalid OIDC token: ${(e as Error).message}`);
  });
  const workspaceId = (process.env.AZHI_OIDC_WORKSPACE ?? LOCAL_WORKSPACE) as string;
  await ctx.pool.query(`INSERT INTO workspaces(id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [workspaceId]);
  const found = await ctx.pool.query(`SELECT id, role, disabled_at FROM users WHERE workspace_id=$1 AND oidc_issuer=$2 AND oidc_subject=$3`, [workspaceId, issuer, payload.sub]);
  const disabled = () => new AzhiError(ErrorClass.authorization, 'this user is disabled');
  if (found.rows[0]) {
    if (found.rows[0].disabled_at) throw disabled();
    return { kind: 'user', workspaceId, userId: found.rows[0].id, role: found.rows[0].role };
  }
  // An invited user (created by an admin with this email) is claimed on first sign-in, with the
  // role the admin gave; only a verified email can claim one.
  if (typeof payload.email === 'string' && payload.email_verified === true) {
    const invited = await ctx.pool.query(
      `UPDATE users SET oidc_issuer=$3, oidc_subject=$4, display_name=COALESCE(display_name, $5)
       WHERE id = (SELECT id FROM users WHERE workspace_id=$1 AND lower(email)=lower($2) AND oidc_subject IS NULL ORDER BY created_at LIMIT 1)
       RETURNING id, role, disabled_at`,
      [workspaceId, payload.email, issuer, payload.sub, payload.name ?? null],
    );
    if (invited.rows[0]) {
      if (invited.rows[0].disabled_at) throw disabled();
      return { kind: 'user', workspaceId, userId: invited.rows[0].id, role: invited.rows[0].role };
    }
  }
  // The first user of a new workspace becomes its owner; anyone else not invited starts as a viewer.
  const anyUser = await ctx.pool.query(`SELECT 1 FROM users WHERE workspace_id=$1 LIMIT 1`, [workspaceId]);
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
