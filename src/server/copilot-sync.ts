import { checkCopilotToken, copilotSignIn } from '../api/copilot.js';
import { LOCAL_WORKSPACE } from '../api/auth.js';
import { opencodeAuthFile, opencodeCandidates } from '../lib/opencode-auth.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { resolveSecret, setSecret } from './secrets.js';

const SECRET = 'github-copilot-token';
const ACTOR = 'system:opencode-sync';

/**
 * Keeps the local workspace's Copilot sign-in in step with OpenCode's auth.json on this machine, so one
 * `opencode auth login` serves both. Only the local workspace is touched, only the default path is read,
 * and a sign-in Copilot refuses never replaces the saved one. Off with AZHI_COPILOT_SYNC_OPENCODE=0.
 */
export async function syncCopilotFromOpencode(ctx: AppContext, log: (m: string) => void = () => {}): Promise<void> {
  const { candidates } = opencodeCandidates(opencodeAuthFile());
  if (!candidates.length) return;
  const saved = await resolveSecret(ctx, LOCAL_WORKSPACE, SECRET);
  let savedToken: string | undefined;
  try {
    savedToken = saved ? copilotSignIn(saved.value).token : undefined;
  } catch {
    // an unreadable saved value is replaced by a good one
  }
  for (const c of candidates) {
    try {
      const si = copilotSignIn(c.auth);
      if (si.token === savedToken) return; // already the same sign-in
      const enterprise = si.enterprise;
      if (!(await checkCopilotToken(ctx, si.token, enterprise)).ok) continue;
      const version = await setSecret(ctx, LOCAL_WORKSPACE, SECRET, JSON.stringify({ ...si.entry, type: 'oauth' }), ACTOR);
      await audit(ctx, LOCAL_WORKSPACE, ACTOR, 'copilot.imported', { secret: SECRET, version, via: c.name });
      log(`copilot: signed in from OpenCode's auth.json (secret ${SECRET} version ${version})`);
      return;
    } catch (err) {
      log(`copilot: OpenCode sign-in not used: ${(err as Error).message}`);
    }
  }
}

export function startCopilotSync(ctx: AppContext, log: (m: string) => void = () => {}, intervalMs = 30_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncCopilotFromOpencode(ctx, log);
    } catch (err) {
      log(`copilot: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
