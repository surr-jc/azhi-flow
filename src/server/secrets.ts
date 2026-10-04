import { decryptSecret, encryptSecret } from '../security/secrets.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';

export async function setSecret(ctx: AppContext, workspaceId: string, name: string, value: string, actor: string): Promise<number> {
  const r = await ctx.pool.query(
    `INSERT INTO secrets(workspace_id, name, version, ciphertext, created_by)
     SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4 FROM secrets WHERE workspace_id=$1 AND name=$2
     RETURNING version`,
    [workspaceId, name, encryptSecret(ctx.secretKey, value), actor],
  );
  const version = r.rows[0].version as number;
  await audit(ctx, workspaceId, actor, 'secret.changed', { name, version });
  return version;
}

/** Resolves a secret at execution time. Only its name and version are ever recorded. */
export async function resolveSecret(ctx: AppContext, workspaceId: string, name: string): Promise<{ value: string; version: number } | undefined> {
  const r = await ctx.pool.query(`SELECT version, ciphertext FROM secrets WHERE workspace_id=$1 AND name=$2 ORDER BY version DESC LIMIT 1`, [workspaceId, name]);
  const row = r.rows[0];
  return row ? { value: decryptSecret(ctx.secretKey, row.ciphertext), version: row.version } : undefined;
}

export async function listSecrets(ctx: AppContext, workspaceId: string) {
  return (
    await ctx.pool.query(`SELECT name, MAX(version) AS version, MAX(created_at) AS updated_at FROM secrets WHERE workspace_id=$1 GROUP BY name ORDER BY name`, [workspaceId])
  ).rows as Array<{ name: string; version: number; updated_at: Date }>;
}
