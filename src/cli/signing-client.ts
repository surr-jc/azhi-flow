import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PackageSource } from '../definition/package.js';
import { sha256 } from '../lib/hash.js';
import { generateKeyPair, signPackage, type PackageSignature, type PublisherCertificate } from '../security/signing.js';
import type { ApiClient } from '../worker/api-client.js';

interface StoredKey {
  private_key: string;
  certificate: PublisherCertificate;
}

/**
 * The CLI's publisher key for this server and user (ADR-11). Created on first use and certified by
 * the workspace root; the private key never leaves this machine.
 */
export async function publisherKey(api: ApiClient, keyDir = join(homedir(), '.azhi', 'keys')): Promise<StoredKey> {
  const me = await api.get<{ userId: string; workspaceId: string }>('/v1/me');
  const file = join(keyDir, `${sha256(api.baseUrl).slice(0, 12)}-${me.workspaceId}-${me.userId}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const kp = generateKeyPair();
  const certificate = await api.post<PublisherCertificate>('/v1/publisher-keys', { public_key: kp.publicKey });
  const stored = { private_key: kp.privateKey, certificate };
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return stored;
}

export async function signForUpload(api: ApiClient, pkg: PackageSource, workflowId: string, keyDir?: string): Promise<PackageSignature> {
  const key = await publisherKey(api, keyDir);
  return signPackage(key.private_key, key.certificate, pkg.hash, workflowId);
}
