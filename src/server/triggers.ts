import { createHmac, timingSafeEqual } from 'node:crypto';
import { eventValue, triggerFilterPasses } from '../cel/trigger.js';
import type { TriggerEvent } from '../definition/types.js';
import { AzhiError } from '../lib/errors.js';
import { contentHash } from '../lib/hash.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { audit } from './catalog.js';
import type { AppContext } from './context.js';
import { createRun } from './runs.js';
import { resolveSecret } from './secrets.js';
import { resolveVersion } from './workflows.js';

/**
 * Event triggers: a signed webhook starts a run of a workflow's latest published version. The definition's
 * `trigger.events` become rows here when the version is published. The payload is untrusted data: only scalar
 * values at the fixed paths the definition names are copied into the run's inputs, and the workflow's input
 * schema checks them like any other start. Every delivery is recorded, with the reason when it starts nothing.
 */
export const DEFAULT_TRIGGER_SECRET = 'webhook-secret';
const MAX_INPUT_CHARS = 500;
export const HOOK_PATH = '/v1/hooks/';

export type DeliveryOutcome = 'started' | 'duplicate' | 'ignored' | 'filtered' | 'refused';

export interface TriggerRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  slug?: string;
  source: 'github' | 'webhook';
  events: string[];
  filter: string | null;
  input_map: Record<string, string>;
  secret_name: string;
  enabled: boolean;
}

/** Rewrites a workflow's trigger rows from a published definition. A trigger keeps its on/off switch across versions. */
export async function syncTriggers(ctx: AppContext, workspaceId: string, workflowId: string, events: TriggerEvent[] | undefined) {
  const wanted = (events ?? []).map((ev, i) => ({ ev, id: `trg_${workflowId.slice(3)}_${i}` }));
  for (const { ev, id } of wanted) {
    await ctx.pool.query(
      `INSERT INTO triggers(id, workspace_id, workflow_id, source, events, filter, input_map, secret_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET source=$4, events=$5, filter=$6, input_map=$7, secret_name=$8`,
      [id, workspaceId, workflowId, ev.source, ev.on ?? [], ev.when ?? null, JSON.stringify(ev.inputs ?? {}), ev.secret ?? DEFAULT_TRIGGER_SECRET],
    );
  }
  await ctx.pool.query(`DELETE FROM triggers WHERE workflow_id=$1 AND NOT (id = ANY($2))`, [workflowId, wanted.map((w) => w.id)]);
}

export async function removeTriggers(ctx: { query: (t: string, v?: unknown[]) => Promise<unknown> }, workflowId: string) {
  await ctx.query(`DELETE FROM trigger_deliveries WHERE trigger_id IN (SELECT id FROM triggers WHERE workflow_id=$1)`, [workflowId]);
  await ctx.query(`DELETE FROM triggers WHERE workflow_id=$1`, [workflowId]);
}

export function listTriggers(ctx: AppContext, workspaceId: string) {
  return ctx.pool
    .query(
      `SELECT t.id, w.slug AS workflow, t.source, t.events, t.filter, t.input_map, t.secret_name, t.enabled,
         (SELECT count(*)::int FROM trigger_deliveries d WHERE d.trigger_id=t.id) AS deliveries,
         (SELECT max(received_at) FROM trigger_deliveries d WHERE d.trigger_id=t.id) AS last_delivery_at
       FROM triggers t JOIN workflows w ON w.id=t.workflow_id WHERE t.workspace_id=$1 ORDER BY w.slug, t.id`,
      [workspaceId],
    )
    .then((r) => r.rows);
}

export function listDeliveries(ctx: AppContext, workspaceId: string, triggerId: string, limit = 50) {
  return ctx.pool
    .query(`SELECT delivery_id, event, outcome, reason, run_id, received_at FROM trigger_deliveries WHERE workspace_id=$1 AND trigger_id=$2 ORDER BY id DESC LIMIT $3`, [workspaceId, triggerId, limit])
    .then((r) => r.rows);
}

export async function setTriggerEnabled(ctx: AppContext, workspaceId: string, triggerId: string, enabled: boolean, actor: string) {
  const r = await ctx.pool.query(`UPDATE triggers SET enabled=$3 WHERE id=$1 AND workspace_id=$2`, [triggerId, workspaceId, enabled]);
  if (!r.rowCount) return false;
  await audit(ctx, workspaceId, actor, 'trigger.toggled', { trigger: triggerId, enabled });
  return true;
}

/** `sha256=<hex>` of the HMAC of the raw body, as GitHub and Azhi webhooks send it. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyBody(secret: string, signature: string | undefined, body: string): boolean {
  if (!signature) return false;
  const expected = signBody(secret, body);
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** `pull_request.opened`: GitHub's event and its action; for a generic webhook, the X-Azhi-Event value. */
export function eventName(source: TriggerRow['source'], headers: Record<string, string | string[] | undefined>, payload: unknown): string | undefined {
  if (source === 'webhook') return header(headers, 'x-azhi-event');
  const base = header(headers, 'x-github-event');
  const action = payload && typeof payload === 'object' ? (payload as { action?: unknown }).action : undefined;
  return base ? (typeof action === 'string' ? `${base}.${action}` : base) : undefined;
}

/** An `on` entry of `pull_request` matches every `pull_request.<action>`. */
export function eventMatches(on: string[], event: string | undefined): boolean {
  if (!on.length) return true;
  return event !== undefined && on.some((o) => o === event || event.startsWith(`${o}.`));
}

export interface DeliveryResult {
  status: number;
  body: { outcome: DeliveryOutcome | 'unauthorized' | 'invalid'; run_id?: string; reason?: string };
}

export async function handleDelivery(
  ctx: AppContext,
  triggerId: string,
  headers: Record<string, string | string[] | undefined>,
  raw: string,
  interpreterBuild: string,
): Promise<DeliveryResult> {
  // Every authentication failure looks the same, so the id of a trigger is not a way to find out whether it exists.
  const unauthorized: DeliveryResult = { status: 401, body: { outcome: 'unauthorized', reason: 'signature does not match' } };
  const t = (await ctx.pool.query(`SELECT t.*, w.slug FROM triggers t JOIN workflows w ON w.id=t.workflow_id WHERE t.id=$1`, [triggerId])).rows[0] as TriggerRow | undefined;
  if (!t) return unauthorized;
  const secret = await resolveSecret(ctx, t.workspace_id, t.secret_name);
  const signature = header(headers, t.source === 'github' ? 'x-hub-signature-256' : 'x-azhi-signature-256');
  if (!secret || !verifyBody(secret.value, signature, raw)) return unauthorized;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { outcome: 'invalid', reason: 'the body is not JSON' } };
  }
  const event = eventName(t.source, headers, payload);
  const deliveryId = (t.source === 'github' ? header(headers, 'x-github-delivery') : header(headers, 'x-azhi-delivery')) ?? contentHash(raw);

  const claimed = await ctx.pool.query(`INSERT INTO trigger_deliveries(trigger_id, workspace_id, delivery_id, event, outcome) VALUES ($1,$2,$3,$4,'received') ON CONFLICT (trigger_id, delivery_id) DO NOTHING`, [
    t.id,
    t.workspace_id,
    deliveryId,
    event ?? null,
  ]);
  if (!claimed.rowCount) {
    const prior = (await ctx.pool.query(`SELECT outcome, run_id FROM trigger_deliveries WHERE trigger_id=$1 AND delivery_id=$2`, [t.id, deliveryId])).rows[0] as { outcome: string; run_id: string | null };
    // A delivery that was claimed but never finished (the server stopped) is processed again; the run's occurrence id keeps that safe.
    if (prior.outcome !== 'received') return { status: 200, body: { outcome: 'duplicate', ...(prior.run_id ? { run_id: prior.run_id } : {}) } };
  }

  const finish = async (outcome: DeliveryOutcome, status: number, reason?: string, runId?: string): Promise<DeliveryResult> => {
    await ctx.pool.query(`UPDATE trigger_deliveries SET outcome=$3, reason=$4, run_id=$5 WHERE trigger_id=$1 AND delivery_id=$2`, [t.id, deliveryId, outcome, reason ?? null, runId ?? null]);
    return { status, body: { outcome, ...(reason ? { reason } : {}), ...(runId ? { run_id: runId } : {}) } };
  };

  if (event === 'ping') return finish('ignored', 200, 'ping');
  if (!t.enabled) return finish('ignored', 200, 'the trigger is off');
  if (!eventMatches(t.events, event)) return finish('ignored', 200, `event ${event ?? '(none)'} is not one of: ${t.events.join(', ')}`);
  if (t.filter) {
    const f = triggerFilterPasses(t.filter, payload);
    if (!f.pass) return finish('filtered', 200, f.error ? `filter could not be evaluated: ${f.error}` : 'the filter is false');
  }

  const inputs: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(t.input_map)) {
    const v = eventValue(payload, path);
    if (v === undefined) continue;
    if (typeof v === 'string' && v.length > MAX_INPUT_CHARS) return finish('refused', 422, `${name} is longer than ${MAX_INPUT_CHARS} characters`);
    inputs[name] = v;
  }

  try {
    const version = await resolveVersion(ctx, t.workspace_id, `${t.slug}@latest`);
    if (!version) return finish('refused', 422, 'the workflow has no published version');
    const publisher = (await ctx.pool.query(`SELECT u.id AS "userId", u.role FROM users u WHERE u.id = (SELECT published_by FROM workflow_versions WHERE id=$1)`, [version.id])).rows[0] as { userId: string; role: string } | undefined;
    const plan = await buildRunPlan(ctx, t.workspace_id, version, publisher);
    if (!plan.ok) return finish('refused', 422, `run plan has ${plan.blockers.length} blocker(s): ${plan.blockers.map((b) => (b.node ? `${b.node}: ` : '') + b.message).join('; ')}`);
    const r = await createRun(ctx, t.workspace_id, { version, inputs, trigger: 'event', createdBy: `trigger:${t.id}`, occurrenceId: `${t.id}@${deliveryId}`, interpreterBuild, plan });
    return finish(r.created ? 'started' : 'duplicate', r.created ? 202 : 200, undefined, r.runId);
  } catch (err) {
    // A refusal (inputs that do not fit the schema, a spend limit) is final for this delivery: the sender is told, nothing is retried into a second run.
    const message = err instanceof AzhiError ? err.message : (err as Error).message;
    return finish('refused', 422, message.slice(0, 500));
  }
}
