import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AzhiError, ErrorClass } from '../lib/errors.js';

/**
 * SSRF protection (spec section 10): tool and connector endpoints may not reach private,
 * loopback or link-local addresses unless the host is on the admin egress allowlist
 * (AZHI_EGRESS_ALLOW, comma-separated hostnames or host:port).
 */
export async function checkEgress(url: string, allow = (process.env.AZHI_EGRESS_ALLOW ?? '').split(',').filter(Boolean)) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new AzhiError(ErrorClass.authorization, `egress to ${u.protocol} is not allowed`);
  if (allow.includes(u.hostname) || allow.includes(u.host)) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) {
    if (isPrivate(a)) throw new AzhiError(ErrorClass.authorization, `egress to private address ${a} (${u.hostname}) is blocked; add it to AZHI_EGRESS_ALLOW`);
  }
}

export function isPrivate(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
