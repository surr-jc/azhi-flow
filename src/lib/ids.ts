import { randomBytes } from 'node:crypto';

/** Prefixed, time-ordered IDs: `<prefix>_<10 hex ms><12 hex random>`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(16).padStart(12, '0')}${randomBytes(6).toString('hex')}`;
}
