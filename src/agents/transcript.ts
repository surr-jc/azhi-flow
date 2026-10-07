import type pg from 'pg';

/**
 * Agent transcripts: what an agent step said and did, entry by entry (the prompts it was given,
 * the model's text and reasoning, each tool call with its input and result). Harness adapters
 * send entries while the step runs, so the run page can follow it live; an entry with the same id
 * replaces the earlier one (OpenCode streams a text part or a tool call through several states).
 * Everything is redacted before it is stored: known secret values and token-shaped strings.
 */
export type TranscriptKind = 'system' | 'user' | 'assistant' | 'reasoning' | 'tool' | 'step' | 'error' | 'note';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  text?: string;
  /** Tool calls: the tool's name, its state, input and result (or error). */
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  /** Model calls (kind step): the model and its token counts. */
  model?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache_read?: number; cache_write?: number };
  /** Milliseconds since the epoch, when the harness reports it. */
  at?: number;
}

/** Longest text kept per field; a tool result past it keeps its start and end. */
export const TRANSCRIPT_FIELD_MAX = 32 * 1024;
/** Most entries stored per step attempt; later ones are dropped with a note. */
export const TRANSCRIPT_MAX_ENTRIES = 2000;

const KINDS = new Set<TranscriptKind>(['system', 'user', 'assistant', 'reasoning', 'tool', 'step', 'error', 'note']);

/** Strings that look like credentials whoever wrote them: provider keys, GitHub, Slack and AWS tokens, bearer headers. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bazr\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** A redactor for the given secret values (short ones are ignored: they would blank ordinary words). */
export function redactor(secrets: Array<string | undefined>): (s: string) => string {
  const values = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.trim().length >= 8).map((s) => s.trim()))].sort((a, b) => b.length - a.length);
  return (s: string) => {
    let out = s;
    for (const v of values) if (out.includes(v)) out = out.split(v).join('[redacted]');
    for (const p of TOKEN_PATTERNS) out = out.replace(p, (m, scheme?: string) => (typeof scheme === 'string' && /^(bearer|basic|token)$/i.test(scheme) ? `${scheme} [redacted]` : '[redacted]'));
    return out;
  };
}

function clip(s: string, max = TRANSCRIPT_FIELD_MAX): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 60) / 2);
  return `${s.slice(0, half)}\n… [${s.length - 2 * half} characters not kept] …\n${s.slice(-half)}`;
}

/** Redacts and bounds every string in a value (tool inputs are JSON). */
function scrubValue(v: unknown, redact: (s: string) => string, depth = 0): unknown {
  if (typeof v === 'string') return clip(redact(v), 8 * 1024);
  if (v === null || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrubValue(x, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    out[k] = /^(api[_-]?key|token|password|secret|authorization|auth|credential)s?$/i.test(k) && typeof x === 'string' ? '[redacted]' : scrubValue(x, redact, depth + 1);
  }
  return out;
}

/** An entry made safe to store and show: known fields only, redacted and bounded. */
export function scrubEntry(e: TranscriptEntry, redact: (s: string) => string): TranscriptEntry | undefined {
  if (!e || typeof e.id !== 'string' || !e.id || !KINDS.has(e.kind)) return undefined;
  const s = (x: unknown) => (typeof x === 'string' ? clip(redact(x)) : undefined);
  const out: TranscriptEntry = { id: e.id.slice(0, 200), kind: e.kind };
  if (s(e.text) !== undefined) out.text = s(e.text);
  if (typeof e.tool === 'string') out.tool = e.tool.slice(0, 200);
  if (e.status && ['pending', 'running', 'completed', 'error'].includes(e.status)) out.status = e.status;
  if (e.input !== undefined) {
    const input = scrubValue(e.input, redact);
    out.input = JSON.stringify(input).length > TRANSCRIPT_FIELD_MAX ? clip(JSON.stringify(input)) : input;
  }
  if (s(e.output) !== undefined) out.output = s(e.output);
  if (s(e.error) !== undefined) out.error = s(e.error);
  if (typeof e.model === 'string') out.model = e.model.slice(0, 200);
  if (e.tokens && typeof e.tokens === 'object') {
    out.tokens = Object.fromEntries(Object.entries(e.tokens).filter(([k, v]) => ['input', 'output', 'reasoning', 'cache_read', 'cache_write'].includes(k) && typeof v === 'number'));
  }
  if (typeof e.at === 'number' && Number.isFinite(e.at)) out.at = e.at;
  return out;
}

/** Stores entries for one step attempt; an entry id seen before is replaced and keeps its place. */
export async function writeTranscript(pool: pg.Pool, w: { workspaceId: string; runId: string; nodeId: string; attempt: number }, entries: TranscriptEntry[], redact: (s: string) => string): Promise<number> {
  const clean = entries.map((e) => scrubEntry(e, redact)).filter((e): e is TranscriptEntry => Boolean(e));
  if (!clean.length) return 0;
  const count = Number(
    (await pool.query(`SELECT count(*)::int AS n FROM agent_transcripts WHERE run_id=$1 AND node_id=$2 AND attempt=$3`, [w.runId, w.nodeId, w.attempt])).rows[0].n,
  );
  let room = TRANSCRIPT_MAX_ENTRIES - count;
  let stored = 0;
  for (const e of clean) {
    const { id, kind, ...data } = e;
    const r = await pool.query(
      `INSERT INTO agent_transcripts(workspace_id, run_id, node_id, attempt, entry_id, kind, data)
       SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $8 OR EXISTS (SELECT 1 FROM agent_transcripts WHERE run_id=$2 AND node_id=$3 AND attempt=$4 AND entry_id=$5)
       ON CONFLICT (run_id, node_id, attempt, entry_id) DO UPDATE SET kind=EXCLUDED.kind, data=EXCLUDED.data, version=nextval('agent_transcripts_version'), at=now()
       RETURNING (xmax = 0) AS inserted`,
      [w.workspaceId, w.runId, w.nodeId, w.attempt, id, kind, JSON.stringify(data), room > 0],
    );
    if (!r.rows[0]) continue;
    stored++;
    if (r.rows[0].inserted) room--;
    if (room === 0) {
      room = -1;
      await pool.query(
        `INSERT INTO agent_transcripts(workspace_id, run_id, node_id, attempt, entry_id, kind, data) VALUES ($1,$2,$3,$4,'azhi-truncated','note',$5) ON CONFLICT DO NOTHING`,
        [w.workspaceId, w.runId, w.nodeId, w.attempt, JSON.stringify({ text: `Only the first ${TRANSCRIPT_MAX_ENTRIES} entries of this step are kept.` })],
      );
    }
  }
  return stored;
}

export interface StoredTranscriptEntry extends TranscriptEntry {
  node_id: string;
  attempt: number;
  ord: number;
  version: number;
  updated_at: string;
}

/** Entries changed after `after` (a version cursor), optionally for one step; callers order them by `ord`. */
export async function readTranscript(pool: pg.Pool, workspaceId: string, runId: string, opts: { after?: number; node?: string } = {}): Promise<{ entries: StoredTranscriptEntry[]; cursor: number }> {
  const rows = (
    await pool.query(
      `SELECT node_id, attempt, entry_id, kind, data, ord, version, at FROM agent_transcripts
       WHERE workspace_id=$1 AND run_id=$2 AND version > $3 AND ($4::text IS NULL OR node_id=$4) ORDER BY version LIMIT 5000`,
      [workspaceId, runId, opts.after ?? 0, opts.node ?? null],
    )
  ).rows;
  const entries = rows.map((r) => ({ ...(r.data as object), id: r.entry_id, kind: r.kind, node_id: r.node_id, attempt: r.attempt, ord: Number(r.ord), version: Number(r.version), updated_at: r.at }) as StoredTranscriptEntry);
  return { entries, cursor: entries.reduce((m, e) => Math.max(m, e.version), opts.after ?? 0) };
}
