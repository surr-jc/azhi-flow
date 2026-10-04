import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Secrets are encrypted at rest with AES-256-GCM. The key comes from AZHI_SECRET_KEY (64 hex chars)
 * or, in local mode, a key file created with 0600 permissions in the data directory. In team
 * deployments, AZHI_SECRET_KEY should come from a KMS or secrets manager.
 */
export function loadSecretKey(envKey: string | undefined, keyFile: string): Buffer {
  if (envKey) {
    const key = Buffer.from(envKey, 'hex');
    if (key.length !== 32) throw new Error('AZHI_SECRET_KEY must be 64 hex characters');
    return key;
  }
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(key: Buffer, blob: Buffer): string {
  if (blob[0] !== 1) throw new Error('unknown secret format');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
}
