/** A ChatGPT plan sign-in as OpenCode keeps it (its auth.json `openai` entry). Shared by the server and the worker. */
export interface ChatgptAuth {
  type: 'oauth';
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function claims(jwt: string | undefined): Record<string, any> | undefined {
  const part = jwt?.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The ChatGPT account id OpenCode sends as ChatGPT-Account-Id, read the way OpenCode reads it. */
export function accountIdOf(t: TokenResponse): string | undefined {
  for (const jwt of [t.id_token, t.access_token]) {
    const c = claims(jwt);
    const id = c?.chatgpt_account_id ?? c?.['https://api.openai.com/auth']?.chatgpt_account_id ?? c?.organizations?.[0]?.id;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/**
 * The ChatGPT sign-in a secret holds: Azhi's own `{"openai": {...}}`, or OpenCode's auth.json pasted
 * whole. Undefined for anything else (an API key, a Copilot sign-in).
 */
export function chatgptAuth(value: string): ChatgptAuth | undefined {
  const v = value.trim();
  if (!v.startsWith('{')) return undefined;
  let j: any;
  try {
    j = JSON.parse(v);
  } catch {
    return undefined;
  }
  const e = j?.openai;
  if (!e || e.type !== 'oauth' || typeof e.refresh !== 'string' || !e.refresh) return undefined;
  return { type: 'oauth', refresh: e.refresh, access: typeof e.access === 'string' ? e.access : '', expires: typeof e.expires === 'number' ? e.expires : 0, ...(typeof e.accountId === 'string' && e.accountId ? { accountId: e.accountId } : {}) };
}
