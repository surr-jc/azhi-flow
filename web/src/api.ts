// The web app is a client of the same /v1 API as the CLI. The token lives in this tab's
// sessionStorage; `azhi open` passes it once in the URL fragment, which is removed at once.

const KEY = 'azhi-token';

export function takeTokenFromHash(): void {
  const m = location.hash.match(/token=([^&]+)/);
  if (!m) return;
  setToken(decodeURIComponent(m[1]!));
  history.replaceState(null, '', location.pathname + location.search);
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the token lasts for this page only */
  }
  memory = t;
}
let memory: string | null = null;
const token = () => getToken() ?? memory;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token()}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.message ?? `HTTP ${res.status}`, res.status, body.details);
  return body as T;
}

export const isAuthError = (e: unknown) => e instanceof ApiError && (e.status === 401 || (e.status === 403 && /token/i.test(e.message)));

export const RANK: Record<string, number> = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 };
export const atLeast = (role: string | undefined, min: string) => (RANK[role ?? ''] ?? -1) >= (RANK[min] ?? 99);

export const TERMINAL = ['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'];

// ---- shapes returned by the API (only the fields the app reads) ---------------------------------

export interface Me {
  kind: 'user' | 'run';
  workspaceId: string;
  userId?: string;
  role?: string;
}

export interface RunRow {
  id: string;
  state: string;
  flags: Record<string, any>;
  trigger: string;
  test?: boolean;
  inputs?: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
  workflow: string;
  version: number;
}

export interface Approval {
  run_id: string;
  node_id: string;
  workflow: string;
  version: number;
  run_state: string;
  test: boolean;
  requested_at: string;
  request: { message?: unknown; payload?: unknown; role?: string; expires_at?: string; on_expiry?: string };
  role: string;
  decision_schema: JsonSchema | null;
  expires_at: string | null;
  can_decide: boolean;
}

export interface Alert {
  key: string;
  level: 'critical' | 'warning' | 'info';
  kind: string;
  message: string;
  run_id?: string;
  workflow?: string;
  at?: string;
}

export interface Spend {
  turns: number;
  unpriced_turns: number;
  amount: number;
  /** GitHub Copilot AI Credits; null without Copilot turns. */
  credits?: number | null;
  currency: string;
  complete: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface Overview {
  open: Record<string, number>;
  last_24h: Record<string, number>;
  workers: { total: number; online: number };
  approvals: { pending: number; mine: number };
  spend: { today: Spend; week: Spend };
  schedules: ScheduleRow[];
}

export interface ScheduleRow {
  id: string;
  workflow: string;
  cron: string;
  timezone: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  next_occurrence_at: string | null;
  last_run: { id: string; state: string; created_at: string } | null;
}

export interface WorkflowSummary {
  slug: string;
  latest: { id: string; version: number; draft: boolean; signed: boolean; created_at: string; name: string | null; description: string | null } | null;
  published: { id: string; version: number; signed: boolean; created_at: string } | null;
  schedule: { id: string; cron: string; timezone: string; enabled: boolean; next_occurrence_at: string | null } | null;
  last_run: { id: string; state: string; created_at: string } | null;
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  format?: string;
}

export interface RunPlan {
  workflow: string;
  version: number;
  package_hash: string;
  signer: { publisher?: string; verified: boolean; error?: string };
  ok: boolean;
  nodes: Array<{ id: string; type: string; executor?: string; requirements: Array<{ name: string; mark: string; detail: string }>; coverage: Array<{ action: string; enforcement: string; detail: string }>; tainted?: string; model?: { provider: string; name: string | null; source: 'profile' | 'server_default' | 'workflow_default' | 'run_choice' } }>;
  blockers: Array<{ code: string; message: string; node?: string }>;
  missing_grants: Array<{ kind: string; name: string; node: string }>;
}

export interface PreflightCheck {
  id: string;
  kind: 'plan' | 'tool' | 'secret' | 'dataset' | 'github' | 'slack';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  target: string;
  node?: string;
  message: string;
  fix?: string;
}
export interface PreflightReport { ok: boolean; checks: PreflightCheck[] }

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'azhi-theme';

/** The theme chosen in this browser (a convenience; the system setting is the default). */
export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
}
