import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SignInCandidate { name: string; auth: string }

export const opencodeAuthFile = () => join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'auth.json');

/** The github-copilot sign-ins in OpenCode's auth.json, as candidates for /v1/copilot/import; `problem` says why there are none. */
export function opencodeCandidates(file: string): { candidates: SignInCandidate[]; problem?: string } {
  if (!existsSync(file)) return { candidates: [], problem: `no OpenCode sign-in file at ${file}` };
  const candidates: SignInCandidate[] = [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of Object.keys(j).filter((x) => x.startsWith('github-copilot'))) {
      const e = j[k];
      const label = `OpenCode auth.json: ${k}${e?.enterpriseUrl ? ` (${e.enterpriseUrl})` : ''}`;
      candidates.push({ name: label, auth: JSON.stringify({ [k]: e }) });
      // Some OpenCode versions send the entry's `access` token rather than `refresh`.
      if (typeof e?.access === 'string' && e.access && e.access !== e.refresh) candidates.push({ name: `${label}, its access token`, auth: JSON.stringify({ [k]: { ...e, refresh: e.access } }) });
    }
  } catch {
    return { candidates: [], problem: `${file} is not JSON` };
  }
  return candidates.length ? { candidates } : { candidates, problem: `${file} has no github-copilot sign-in` };
}
