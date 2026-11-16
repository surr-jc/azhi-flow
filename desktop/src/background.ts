import { app, dialog, Notification, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Things the app does while its window is closed: tell the user an approval is waiting, say when a
 * newer release exists, and, once, which tools the worker could not find. All of it reads the local
 * server's API with the owner token, so it adds no new endpoint. Nothing is sent anywhere but the
 * release check, which asks GitHub for the latest release of this repository and sends no user data.
 */
export interface Session {
  origin: string;
  token: string;
}

export interface Hooks {
  /** Brings the window to the front, optionally on a path of the local UI (for example `/ui/runs/<id>`). */
  show(path?: string): void;
}

interface State {
  updateNotified?: string;
  toolsPrompted?: string;
  trayHintShown?: boolean;
}

const RELEASES_API = 'https://api.github.com/repos/surr-jc/azhi-flow/releases/latest';
const RELEASES_PAGE = 'https://github.com/surr-jc/azhi-flow/releases/';

export function createState(file: string) {
  let s: State = {};
  try {
    s = JSON.parse(readFileSync(file, 'utf8')) as State;
  } catch {
    // first run, or unreadable: start fresh
  }
  return {
    get: <K extends keyof State>(k: K): State[K] => s[k],
    set(patch: State) {
      s = { ...s, ...patch };
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(s, null, 2));
      } catch {
        // a state file that cannot be written only means a prompt may repeat
      }
    },
  };
}
export type AppState = ReturnType<typeof createState>;

const notify = (title: string, body: string, onClick?: () => void) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
};

async function api<T>(session: Session, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${session.origin}${path}`, { headers: { authorization: `Bearer ${session.token}` } });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

interface Approval {
  run_id: string;
  node_id: string;
  workflow: string;
  can_decide?: boolean;
  test?: boolean;
}

/** Polls pending approvals; notifies for each new one this user may decide. */
function watchApprovals(session: Session, hooks: Hooks, every = 30_000) {
  const seen = new Set<string>();
  let primed = false;
  const tick = async () => {
    const items = await api<Approval[]>(session, '/v1/approvals');
    if (!items) return;
    const mine = items.filter((a) => a.can_decide && !a.test);
    const fresh = mine.filter((a) => !seen.has(`${a.run_id}/${a.node_id}`));
    for (const a of mine) seen.add(`${a.run_id}/${a.node_id}`);
    const first = fresh[0];
    if (!first) {
      primed = true;
      return;
    }
    // At start-up, or when several arrive together, one summary beats a burst of notifications.
    if (!primed || fresh.length > 3) {
      notify('Approvals waiting', `${fresh.length} approval${fresh.length === 1 ? ' is' : 's are'} waiting for you.`, () => hooks.show('/ui'));
    } else {
      for (const a of fresh) notify('Approval needed', `${a.workflow}: ${a.node_id}`, () => hooks.show(`/ui/runs/${encodeURIComponent(a.run_id)}`));
    }
    primed = true;
  };
  void tick();
  return setInterval(() => void tick(), every);
}

const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4).map(Number);
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** Tells the user a newer release exists and links to it. No silent update: builds are unsigned. */
async function checkForUpdate(state: AppState) {
  if (process.env.AZHI_DESKTOP_NO_UPDATE_CHECK) return;
  try {
    const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'azhi-flow-desktop' } });
    if (!res.ok) return;
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!rel.tag_name || !isNewer(rel.tag_name, app.getVersion()) || state.get('updateNotified') === rel.tag_name) return;
    const url = rel.html_url?.startsWith(RELEASES_PAGE) ? rel.html_url : RELEASES_PAGE;
    state.set({ updateNotified: rel.tag_name });
    notify('Azhi Flow update available', `${rel.tag_name} is out. Click to open the download page.`, () => void shell.openExternal(url));
  } catch {
    // offline: try again at the next interval
  }
}

interface Worker {
  online?: boolean;
  capabilities?: { runtimes?: { git?: unknown; python?: unknown; bun?: unknown } };
}

const INSTALL = {
  git: 'https://git-scm.com/downloads',
  python: 'https://docs.astral.sh/uv/getting-started/installation/',
  bun: 'https://bun.sh',
};

/** Once per set of missing tools: says what the worker could not find and links to the installers. */
async function checkTools(session: Session, state: AppState) {
  const workers = (await api<Worker[]>(session, '/v1/workers'))?.filter((w) => w.online);
  const rt = workers?.[0]?.capabilities?.runtimes;
  if (!rt) return;
  const missing: Array<keyof typeof INSTALL> = [];
  if (!rt.git) missing.push('git');
  if (!rt.python) missing.push('python');
  if (!rt.bun) missing.push('bun');
  // Bun is optional: it alone is not worth interrupting for.
  const needed = missing.filter((m) => m !== 'bun');
  const signature = missing.join(',');
  if (needed.length === 0 || state.get('toolsPrompted') === signature) return;
  state.set({ toolsPrompted: signature });
  const label = { git: 'Git (runs that work on a repository)', python: 'Python or uv (script steps)', bun: 'Bun (optional, script steps)' };
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Azhi Flow: tools not found',
    message: 'Some tools were not found on this computer.',
    detail: `${missing.map((m) => `• ${label[m]}`).join('\n')}\n\nWorkflows that need them will say so before they run. Install them any time; Azhi Flow checks again when it starts.`,
    buttons: ['Open install pages', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) for (const m of missing) void shell.openExternal(INSTALL[m]);
}

export function startBackground(session: Session, hooks: Hooks, state: AppState) {
  const timers = [watchApprovals(session, hooks)];
  // The worker registers a few seconds after the server is up.
  setTimeout(() => void checkTools(session, state), 20_000);
  setTimeout(() => void checkForUpdate(state), 5_000);
  timers.push(setInterval(() => void checkForUpdate(state), 24 * 3600_000));
  return () => timers.forEach((t) => clearInterval(t));
}

export { notify };
