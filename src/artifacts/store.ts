import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Content-addressed artifact store on the local filesystem (spec section 6). Large outputs,
 * raw tool payloads and package files live here and are referenced by `sha256:<hex>`.
 * An S3-compatible backend implements the same interface in production.
 */
export interface ArtifactStore {
  put(data: Buffer | string): { hash: string; size: number };
  get(hash: string): Buffer | undefined;
  has(hash: string): boolean;
}

export function fsArtifactStore(root: string): ArtifactStore {
  const pathOf = (hash: string) => {
    const hex = hash.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid artifact hash: ${hash}`);
    return join(root, hex.slice(0, 2), hex.slice(2, 4), hex);
  };
  return {
    put(data) {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      const hash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
      const path = pathOf(hash);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, buf);
        renameSync(tmp, path);
      }
      return { hash, size: buf.length };
    },
    get(hash) {
      const path = pathOf(hash);
      return existsSync(path) ? readFileSync(path) : undefined;
    },
    has: (hash) => existsSync(pathOf(hash)),
  };
}

/** A node output stored as an artifact is replaced by this handle in run state. */
export interface ArtifactHandle {
  $artifact: { hash: string; size: number; media_type: string };
}

export function isArtifactHandle(v: unknown): v is ArtifactHandle {
  return Boolean(v && typeof v === 'object' && '$artifact' in (v as object));
}

/** Outputs above this size become artifacts automatically (spec section 7). */
export const ARTIFACT_THRESHOLD_BYTES = 256 * 1024;
