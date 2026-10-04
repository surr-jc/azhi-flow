import { encryptSecret, decryptSecret } from '../security/secrets.js';
import { generateKeyPair, issueCertificate, keyId, trustAccepts, verifyPackageSignature, type PackageSignature, type PublisherCertificate, type TrustPolicy } from '../security/signing.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';

export async function workspaceRoot(ctx: AppContext, workspaceId: string): Promise<{ publicKey: string; privateKey: string }> {
  let row = (await ctx.pool.query(`SELECT public_key, private_key FROM workspace_keys WHERE workspace_id=$1`, [workspaceId])).rows[0];
  if (!row) {
    const kp = generateKeyPair();
    await ctx.pool.query(`INSERT INTO workspace_keys(workspace_id, public_key, private_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      workspaceId,
      kp.publicKey,
      encryptSecret(ctx.secretKey, kp.privateKey),
    ]);
    row = (await ctx.pool.query(`SELECT public_key, private_key FROM workspace_keys WHERE workspace_id=$1`, [workspaceId])).rows[0];
  }
  return { publicKey: row.public_key, privateKey: decryptSecret(ctx.secretKey, row.private_key) };
}

/** Certifies a publisher's public key. Only users with the author role or higher may publish. */
export async function registerPublisherKey(ctx: AppContext, workspaceId: string, userId: string, publicKey: string): Promise<PublisherCertificate> {
  const existing = (await ctx.pool.query(`SELECT certificate FROM publisher_keys WHERE key_id=$1 AND workspace_id=$2 AND user_id=$3 AND revoked_at IS NULL`, [keyId(publicKey), workspaceId, userId]))
    .rows[0];
  if (existing) return existing.certificate;
  const root = await workspaceRoot(ctx, workspaceId);
  const cert = issueCertificate(root.privateKey, root.publicKey, { workspace: workspaceId, user_id: userId, public_key: publicKey });
  await ctx.pool.query(`INSERT INTO publisher_keys(key_id, workspace_id, user_id, public_key, certificate) VALUES ($1,$2,$3,$4,$5)`, [
    cert.key_id,
    workspaceId,
    userId,
    publicKey,
    JSON.stringify(cert),
  ]);
  await audit(ctx, workspaceId, userId, 'publisher_key.certified', { key_id: cert.key_id });
  return cert;
}

/** Verifies a signature against the workspace root and checks the key is not revoked. */
export async function checkSignature(ctx: AppContext, workspaceId: string, sig: PackageSignature | null | undefined, packageHash: string) {
  const root = await workspaceRoot(ctx, workspaceId);
  const r = verifyPackageSignature(sig, packageHash, root.publicKey);
  if (!r.ok) return r;
  const key = (await ctx.pool.query(`SELECT revoked_at FROM publisher_keys WHERE key_id=$1 AND workspace_id=$2`, [sig!.key_id, workspaceId])).rows[0];
  if (!key || key.revoked_at) return { ok: false as const, reason: 'publisher key is unknown or revoked' };
  return r;
}

export async function requireValidSignature(ctx: AppContext, workspaceId: string, sig: unknown, packageHash: string, signer: string) {
  const r = await checkSignature(ctx, workspaceId, sig as PackageSignature, packageHash);
  if (!r.ok) throw new AzhiError(ErrorClass.authorization, `package signature rejected: ${r.reason}`);
  if (r.publisher !== signer) throw new AzhiError(ErrorClass.authorization, `package was signed by ${r.publisher}, not by you (${signer})`);
}

export interface WorkerTrustResult {
  worker: string;
  name: string;
  policy: TrustPolicy;
  accepted: boolean;
  reason?: string;
}

/** Evaluates every online worker's trust policy against a package's signer (run plan, spec section 10). */
export async function evaluateWorkerTrust(ctx: AppContext, workspaceId: string, sig: PackageSignature | null, packageHash: string): Promise<{ signer?: string; signatureError?: string; workers: WorkerTrustResult[] }> {
  const workers = (
    await ctx.pool.query(`SELECT id, name, owner_id, trust_policy FROM workers WHERE workspace_id=$1 AND task_queue LIKE 'azhi-exec-%' AND last_heartbeat > now() - interval '30 seconds'`, [
      workspaceId,
    ])
  ).rows as Array<{ id: string; name: string; owner_id: string | null; trust_policy: TrustPolicy }>;
  const check = await checkSignature(ctx, workspaceId, sig, packageHash);
  if (!check.ok) return { signatureError: check.reason, workers: workers.map((w) => ({ worker: w.id, name: w.name, policy: w.trust_policy, accepted: false, reason: check.reason })) };
  const role = (await ctx.pool.query(`SELECT role FROM users WHERE id=$1 AND workspace_id=$2`, [check.publisher, workspaceId])).rows[0]?.role as string | undefined;
  const isPublisher = ['author', 'admin', 'owner'].includes(role ?? '');
  return {
    signer: check.publisher,
    workers: workers.map((w) => {
      const r = trustAccepts(w.trust_policy, check.publisher, { workerOwner: w.owner_id, publisherIsPublisherRole: isPublisher });
      return { worker: w.id, name: w.name, policy: w.trust_policy, accepted: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
    }),
  };
}
