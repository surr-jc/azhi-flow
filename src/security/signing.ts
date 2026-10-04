import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, sha256 } from '../lib/hash.js';

/**
 * Package signing (ADR-06, ADR-11). Ed25519 throughout.
 *
 * - The workspace root key certifies publisher keys: a certificate binds a publisher's public key
 *   to their user ID in that workspace.
 * - A publisher signs a package hash with their own key.
 * - A worker verifies certificate -> signature -> hash, then applies its trust policy to the
 *   publisher's user ID.
 */
export interface KeyPair {
  publicKey: string; // base64 SPKI DER
  privateKey: string; // base64 PKCS8 DER
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

const pub = (b64: string): KeyObject => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
const priv = (b64: string): KeyObject => createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

export function keyId(publicKey: string): string {
  return `key_${sha256(publicKey).slice(0, 16)}`;
}

export interface PublisherCertificate {
  format: 'azhi-publisher-cert/1';
  workspace: string;
  user_id: string;
  key_id: string;
  public_key: string;
  issued_at: string;
  root_key_id: string;
  signature: string;
}

export function issueCertificate(rootPrivate: string, rootPublic: string, body: { workspace: string; user_id: string; public_key: string }): PublisherCertificate {
  const unsigned = {
    format: 'azhi-publisher-cert/1' as const,
    workspace: body.workspace,
    user_id: body.user_id,
    key_id: keyId(body.public_key),
    public_key: body.public_key,
    issued_at: new Date().toISOString(),
    root_key_id: keyId(rootPublic),
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), priv(rootPrivate)).toString('base64') };
}

export function verifyCertificate(cert: PublisherCertificate, rootPublic: string): boolean {
  const { signature, ...unsigned } = cert;
  if (cert.root_key_id !== keyId(rootPublic) || cert.key_id !== keyId(cert.public_key)) return false;
  return verify(null, Buffer.from(canonicalJson(unsigned)), pub(rootPublic), Buffer.from(signature, 'base64'));
}

export interface PackageSignature {
  format: 'azhi-package-sig/1';
  package_hash: string;
  workflow: string;
  publisher: string;
  key_id: string;
  certificate: PublisherCertificate;
  signed_at: string;
  signature: string;
}

const signedBytes = (s: Pick<PackageSignature, 'package_hash' | 'workflow' | 'publisher' | 'key_id' | 'signed_at'>) =>
  Buffer.from(`azhi-package-sig/1\n${s.package_hash}\n${s.workflow}\n${s.publisher}\n${s.key_id}\n${s.signed_at}`);

export function signPackage(privateKey: string, certificate: PublisherCertificate, packageHash: string, workflow: string): PackageSignature {
  const body = { package_hash: packageHash, workflow, publisher: certificate.user_id, key_id: certificate.key_id, signed_at: new Date().toISOString() };
  return { format: 'azhi-package-sig/1', ...body, certificate, signature: sign(null, signedBytes(body), priv(privateKey)).toString('base64') };
}

export type SignatureCheck = { ok: true; publisher: string } | { ok: false; reason: string };

export function verifyPackageSignature(sig: PackageSignature | null | undefined, packageHash: string, rootPublic: string): SignatureCheck {
  if (!sig) return { ok: false, reason: 'package is not signed' };
  if (sig.package_hash !== packageHash) return { ok: false, reason: 'signature is for a different package hash' };
  if (!verifyCertificate(sig.certificate, rootPublic)) return { ok: false, reason: 'publisher certificate is not issued by this workspace root key' };
  if (sig.publisher !== sig.certificate.user_id || sig.key_id !== sig.certificate.key_id) return { ok: false, reason: 'signature does not match its certificate' };
  if (!verify(null, signedBytes(sig), pub(sig.certificate.public_key), Buffer.from(sig.signature, 'base64'))) return { ok: false, reason: 'signature does not verify' };
  return { ok: true, publisher: sig.publisher };
}

/** Worker trust policy (spec section 10). */
export type TrustPolicy = { kind: 'self' } | { kind: 'authors'; authors: string[] } | { kind: 'workspace-publishers' };

export function trustAccepts(policy: TrustPolicy, publisher: string, ctx: { workerOwner: string | null; publisherIsPublisherRole: boolean }): { ok: boolean; reason?: string } {
  switch (policy.kind) {
    case 'self':
      return publisher === ctx.workerOwner ? { ok: true } : { ok: false, reason: `policy 'self' accepts only ${ctx.workerOwner ?? 'the worker owner'}; package signed by ${publisher}` };
    case 'authors':
      return policy.authors.includes(publisher) ? { ok: true } : { ok: false, reason: `policy 'authors' accepts ${policy.authors.join(', ')}; package signed by ${publisher}` };
    case 'workspace-publishers':
      return ctx.publisherIsPublisherRole ? { ok: true } : { ok: false, reason: `${publisher} does not hold the publisher (author) role` };
  }
}

export function parseTrustPolicy(s: string): TrustPolicy {
  if (s === 'self') return { kind: 'self' };
  if (s === 'workspace-publishers') return { kind: 'workspace-publishers' };
  if (s.startsWith('authors:')) return { kind: 'authors', authors: s.slice(8).split(',').filter(Boolean) };
  throw new Error(`unknown trust policy '${s}': use self, authors:<id,...> or workspace-publishers`);
}
