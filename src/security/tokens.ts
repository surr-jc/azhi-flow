import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../lib/hash.js';

/** API tokens: random, shown once, stored only as a hash. */
export function newApiToken(): { token: string; hash: string } {
  const token = `azhi_${randomBytes(24).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function hashApiToken(token: string): string {
  return sha256(token);
}

/**
 * Run-scoped tokens (spec section 9): short-lived, bound to one run and node, listing the tools the
 * caller may use. Scripts and harnesses get these, never administrator credentials.
 */
export interface RunTokenClaims {
  ws: string;
  run: string;
  node: string;
  tools: string[];
  exp: number;
}

export function signRunToken(key: Buffer, claims: RunTokenClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', key).update(`azhi-run.${body}`).digest('base64url');
  return `azr.${body}.${mac}`;
}

export function verifyRunToken(key: Buffer, token: string, now = Date.now()): RunTokenClaims | undefined {
  const [prefix, body, mac] = token.split('.');
  if (prefix !== 'azr' || !body || !mac) return undefined;
  const expected = createHmac('sha256', key).update(`azhi-run.${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as RunTokenClaims;
  return claims.exp * 1000 > now ? claims : undefined;
}
