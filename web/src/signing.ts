// Publisher signing in the browser (ADR-11), the web twin of the CLI's ~/.azhi/keys: an Ed25519 key
// made in this browser with WebCrypto, marked non-extractable so the private half can't be read
// back out (not even by this page), kept in IndexedDB for this site, and certified once by the
// workspace root through POST /v1/publisher-keys. Workers run signed packages only, so drafts made
// in the browser (uploads, editor saves, examples) are signed here before they run.
import { api } from './api';

interface Certificate { key_id: string; user_id: string; public_key: string; [k: string]: unknown }
interface Stored { privateKey: CryptoKey; certificate: Certificate }

const DB = 'azhi-keys';
const STORE = 'publisher';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = f(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
};

/** This browser's publisher key for the signed-in user, made and certified on first use. */
export async function publisherKey(): Promise<Stored> {
  const me = await api<{ userId: string; workspaceId: string }>('/v1/me');
  const id = `${location.origin}/${me.workspaceId}/${me.userId}`;
  const found = await idb<Stored | undefined>('readonly', (s) => s.get(id));
  if (found) return found;
  if (!crypto?.subtle) throw new Error('This browser cannot sign here (WebCrypto needs https or localhost). Sign with azhi publish instead.');
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  } catch {
    throw new Error('This browser has no Ed25519 signing (it needs Chrome 137, Edge 137, Firefox 129 or Safari 17, or newer). Sign with azhi publish instead.');
  }
  const publicKey = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const certificate = await api<Certificate>('/v1/publisher-keys', { method: 'POST', body: { public_key: publicKey } });
  const stored: Stored = { privateKey: pair.privateKey, certificate };
  await idb('readwrite', (s) => s.put(stored, id));
  return stored;
}

/** Signs a draft version's package with this browser's key and attaches the signature. */
export async function signVersion(id: string): Promise<void> {
  const v = await api<{ slug: string; package_hash: string }>(`/v1/versions/${encodeURIComponent(id)}`);
  const key = await publisherKey();
  const body = { package_hash: v.package_hash, workflow: v.slug, publisher: key.certificate.user_id, key_id: key.certificate.key_id, signed_at: new Date().toISOString() };
  const bytes = new TextEncoder().encode(`azhi-package-sig/1\n${body.package_hash}\n${body.workflow}\n${body.publisher}\n${body.key_id}\n${body.signed_at}`);
  const signature = b64(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, bytes));
  await api(`/v1/versions/${encodeURIComponent(id)}/signature`, { method: 'POST', body: { signature: { format: 'azhi-package-sig/1', ...body, certificate: key.certificate, signature } } });
}
