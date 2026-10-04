import type { Client } from '@temporalio/client';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { callTool } from '../gateway/gateway.js';
import type { ToolSpec } from '../gateway/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit, loadCatalog, registerTool } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { packageManifest } from '../server/packages.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { createRun, getRunDetail, requestCancel, runEvents } from '../server/runs.js';
import { listSecrets, setSecret } from '../server/secrets.js';
import { publishVersion, resolveVersion, upsertSchedule, uploadPackage } from '../server/workflows.js';
import { authenticate, requireRole, type Principal } from './auth.js';
import { newApiToken } from '../security/tokens.js';
import { newId } from '../lib/ids.js';
import { checkSignature, registerPublisherKey, requireValidSignature, workspaceRoot } from '../server/trust.js';
import { keyId } from '../security/signing.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const STATUS: Record<string, number> = {
  [ErrorClass.authorization]: 403,
  [ErrorClass.invalidInput]: 400,
  [ErrorClass.contractViolation]: 422,
  [ErrorClass.unsupportedCapability]: 422,
  [ErrorClass.workerTrustDenied]: 422,
  [ErrorClass.transient]: 503,
};

export interface ApiOptions {
  ctx: AppContext;
  temporal?: Client;
  interpreterBuild: string;
  logger?: boolean;
}

export function buildApi({ ctx, temporal, interpreterBuild, logger = false }: ApiOptions) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof AzhiError) {
      const status = err.message.includes('not found') ? 404 : (STATUS[err.errorClass] ?? 500);
      return reply.status(status).send({ error: err.errorClass, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? 'internal' : 'request_error', message: (err as Error).message });
  });

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url === '/healthz') return;
    req.principal = await authenticate(ctx, req.headers.authorization);
  });

  const user = (req: FastifyRequest) => {
    if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
    return req.principal;
  };
  const notFound = (what: string) => new AzhiError(ErrorClass.invalidInput, `${what} not found`);

  app.get('/healthz', async () => ({ ok: true, interpreter_build: interpreterBuild }));

  app.get('/v1/me', async (req) => req.principal);

  // Packages and workflow versions
  app.post('/v1/packages', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const body = z.object({ workflow: z.string(), files: z.record(z.string(), z.string()), signature: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const r = await uploadPackage(ctx, p.workspaceId, body, p.userId);
    if (!r.ok) return { ok: false, diagnostics: r.diagnostics };
    const v = r.version;
    if (body.signature) {
      await requireValidSignature(ctx, p.workspaceId, body.signature, v.package_hash, p.userId);
      await ctx.pool.query(`UPDATE workflow_versions SET signature=$2 WHERE id=$1 AND signature IS NULL`, [v.id, JSON.stringify(body.signature)]);
    }
    const signed = (await ctx.pool.query(`SELECT signature IS NOT NULL AS signed FROM workflow_versions WHERE id=$1`, [v.id])).rows[0].signed as boolean;
    return { ok: true, diagnostics: r.diagnostics, version: { id: v.id, workflow: v.slug, version: v.version, package_hash: v.package_hash, draft: v.draft, signed } };
  });

  app.post('/v1/versions/:id/publish', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const { id } = req.params as { id: string };
    const body = z.object({ signature: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    const current = (await ctx.pool.query(`SELECT package_hash, signature FROM workflow_versions WHERE id=$1 AND workspace_id=$2`, [id, p.workspaceId])).rows[0];
    if (!current) throw notFound('workflow version');
    // Publishing requires a valid signature by the publishing user (ADR-06, ADR-11).
    const signature = body.signature ?? current.signature;
    await requireValidSignature(ctx, p.workspaceId, signature, current.package_hash, p.userId);
    const v = await publishVersion(ctx, p.workspaceId, id, p.userId, signature);
    return { id: v.id, workflow: v.slug, version: v.version, draft: v.draft };
  });

  app.get('/v1/versions/:ref', async (req) => {
    const p = user(req);
    const v = await resolveVersion(ctx, p.workspaceId, (req.params as { ref: string }).ref);
    if (!v) throw notFound('workflow version');
    return v;
  });

  // The run plan (spec section 3): what will run where, under which controls, and what blocks it.
  app.get('/v1/versions/:ref/plan', async (req) => {
    const p = user(req);
    const v = await resolveVersion(ctx, p.workspaceId, (req.params as { ref: string }).ref);
    if (!v) throw notFound('workflow version');
    return buildRunPlan(ctx, p.workspaceId, v, { userId: p.userId, role: p.role });
  });

  app.get('/v1/workflows', async (req) => {
    const p = user(req);
    return (
      await ctx.pool.query(
        `SELECT w.slug, MAX(v.version) AS latest_version, MAX(v.version) FILTER (WHERE NOT v.draft) AS published_version, COUNT(v.id)::int AS versions
         FROM workflows w LEFT JOIN workflow_versions v ON v.workflow_id = w.id WHERE w.workspace_id=$1 GROUP BY w.slug ORDER BY w.slug`,
        [p.workspaceId],
      )
    ).rows;
  });

  app.get('/v1/packages/:hash/manifest', async (req) => {
    const ws = req.principal.workspaceId;
    return packageManifest(ctx, ws, decodeURIComponent((req.params as { hash: string }).hash));
  });

  app.get('/v1/packages/:hash/signature', async (req) => {
    const hash = decodeURIComponent((req.params as { hash: string }).hash);
    const row = (await ctx.pool.query(`SELECT signature FROM workflow_versions WHERE workspace_id=$1 AND package_hash=$2 AND signature IS NOT NULL LIMIT 1`, [req.principal.workspaceId, hash]))
      .rows[0];
    return { signature: row?.signature ?? null };
  });

  // Signing and trust
  app.get('/v1/trust/root', async (req) => {
    const root = await workspaceRoot(ctx, req.principal.workspaceId);
    return { public_key: root.publicKey, key_id: keyId(root.publicKey) };
  });

  app.post('/v1/publisher-keys', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const { public_key } = z.object({ public_key: z.string().min(40) }).parse(req.body);
    return registerPublisherKey(ctx, p.workspaceId, p.userId, public_key);
  });

  app.post('/v1/signatures/verify', async (req) => {
    const b = z.object({ package_hash: z.string(), signature: z.record(z.string(), z.unknown()).nullable() }).parse(req.body);
    return checkSignature(ctx, req.principal.workspaceId, b.signature as never, b.package_hash);
  });

  // Users (admin)
  app.post('/v1/users', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ display_name: z.string(), email: z.string().optional(), role: z.enum(['admin', 'author', 'operator', 'viewer']) }).parse(req.body);
    const id = newId('usr');
    await ctx.pool.query(`INSERT INTO users(id, workspace_id, email, display_name, role) VALUES ($1,$2,$3,$4,$5)`, [id, p.workspaceId, b.email ?? null, b.display_name, b.role]);
    const t = newApiToken();
    await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,$4,$5)`, [newId('tok'), p.workspaceId, id, b.display_name, t.hash]);
    await audit(ctx, p.workspaceId, p.userId, 'user.created', { user: id, role: b.role });
    return { id, role: b.role, token: t.token };
  });

  app.get('/v1/users', async (req) => {
    const p = user(req);
    return (await ctx.pool.query(`SELECT id, display_name, email, role, created_at FROM users WHERE workspace_id=$1 ORDER BY created_at`, [p.workspaceId])).rows;
  });

  // Runs
  app.post('/v1/runs', async (req, reply) => {
    const p = user(req);
    requireRole(p, 'operator');
    const body = z.object({ version: z.string(), inputs: z.record(z.string(), z.unknown()).default({}), test: z.boolean().optional() }).parse(req.body);
    const v = await resolveVersion(ctx, p.workspaceId, body.version);
    if (!v) throw notFound(`workflow version ${body.version}`);
    // A run whose plan has blockers is refused before anything executes. Test runs are exempt:
    // `azhi test-node` mocks writes and is how authors debug an incomplete setup.
    if (!body.test) {
      const plan = await buildRunPlan(ctx, p.workspaceId, v, { userId: p.userId, role: p.role });
      if (!plan.ok) {
        const first = plan.blockers[0]!;
        throw new AzhiError(first.code === 'worker_trust_denied' ? ErrorClass.workerTrustDenied : ErrorClass.unsupportedCapability, `run plan has ${plan.blockers.length} blocker(s): ${plan.blockers.map((b) => (b.node ? `${b.node}: ` : '') + b.message).join('; ')}`, { blockers: plan.blockers });
      }
    }
    const r = await createRun(ctx, p.workspaceId, { version: v, inputs: body.inputs, trigger: body.test ? 'test' : 'api', test: body.test, createdBy: p.userId, interpreterBuild });
    return reply.status(202).send({ run_id: r.runId });
  });

  app.get('/v1/runs', async (req) => {
    const p = user(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(req.query);
    return (
      await ctx.pool.query(
        `SELECT r.id, r.state, r.flags, r.trigger, r.created_at, r.ended_at, w.slug AS workflow, v.version FROM runs r
         JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
         WHERE r.workspace_id=$1 ORDER BY r.created_at DESC LIMIT $2`,
        [p.workspaceId, q.limit],
      )
    ).rows;
  });

  app.get('/v1/runs/:id', async (req) => {
    const d = await getRunDetail(ctx, req.principal.workspaceId, (req.params as { id: string }).id);
    if (!d) throw notFound('run');
    if (req.principal.kind === 'run' && req.principal.claims.run !== d.run.id) throw new AzhiError(ErrorClass.authorization, 'run token is for another run');
    return d;
  });

  app.get('/v1/runs/:id/events', async (req, reply) => {
    const p = user(req);
    const { id } = req.params as { id: string };
    const after = Number((req.query as { after?: string }).after ?? req.headers['last-event-id'] ?? 0);
    if (!String(req.headers.accept ?? '').includes('text/event-stream')) {
      return (await runEvents(ctx, p.workspaceId, id, after)).map((e) => ({ ...e, seq: Number(e.seq) }));
    }
    // SSE with cursor resume: clients reconnect with Last-Event-ID.
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let cursor = after;
    let open = true;
    req.raw.on('close', () => (open = false));
    while (open) {
      const events = await runEvents(ctx, p.workspaceId, id, cursor);
      for (const e of events) {
        cursor = Number(e.seq);
        reply.raw.write(`id: ${cursor}\nevent: ${e.kind}\ndata: ${JSON.stringify({ ...e, seq: cursor })}\n\n`);
      }
      const run = (await ctx.pool.query(`SELECT state FROM runs WHERE id=$1`, [id])).rows[0];
      if (!run || ['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'].includes(run.state)) {
        if (!events.length) break;
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    reply.raw.end();
    return reply;
  });

  app.post('/v1/runs/:id/cancel', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    await requestCancel(ctx, p.workspaceId, (req.params as { id: string }).id, p.userId);
    return { ok: true };
  });

  // Workers report script attempts here (they have no database access).
  app.post('/v1/runs/:id/attempts', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    const { id } = req.params as { id: string };
    const b = z
      .object({
        node_id: z.string(),
        attempt: z.number().int().min(1),
        worker_id: z.string(),
        state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
        output: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(req.body);
    const run = (await ctx.pool.query(`SELECT 1 FROM runs WHERE id=$1 AND workspace_id=$2`, [id, p.workspaceId])).rowCount;
    if (!run) throw notFound('run');
    await ctx.pool.query(
      `INSERT INTO node_attempts(workspace_id, run_id, node_id, attempt, state, worker_id, output, error, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5 = 'running' THEN NULL ELSE now() END)
       ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET state=$5, worker_id=$6, output=COALESCE($7, node_attempts.output),
         error=COALESCE($8, node_attempts.error), ended_at=CASE WHEN $5 = 'running' THEN NULL ELSE now() END`,
      [p.workspaceId, id, b.node_id, b.attempt, b.state, b.worker_id, b.output === undefined ? null : JSON.stringify(b.output), b.error === undefined ? null : JSON.stringify(b.error)],
    );
    return { ok: true };
  });

  app.get('/v1/artifacts/:hash', async (req, reply) => {
    const hash = decodeURIComponent((req.params as { hash: string }).hash);
    const known = await ctx.pool.query(`SELECT media_type FROM artifacts WHERE workspace_id=$1 AND hash=$2`, [req.principal.workspaceId, hash]);
    const data = known.rowCount ? ctx.artifacts.get(hash) : undefined;
    if (!data) throw notFound('artifact');
    return reply.header('content-type', known.rows[0].media_type).send(data);
  });

  app.post('/v1/artifacts', async (req) => {
    const ws = req.principal.workspaceId;
    const body = z.object({ data: z.string(), media_type: z.string().default('application/json') }).parse(req.body);
    const a = ctx.artifacts.put(Buffer.from(body.data, 'base64'));
    await ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ws, a.hash, a.size, body.media_type]);
    return a;
  });

  // Admin: tools, secrets, schedules, workers
  app.get('/v1/tools', async (req) => (await loadCatalog(ctx, req.principal.workspaceId)).list());

  app.post('/v1/tools', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const spec = z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
        version: z.number().int().min(1),
        description: z.string(),
        input_schema: z.record(z.string(), z.unknown()),
        output_schema: z.record(z.string(), z.unknown()),
        effect: z.enum(['read', 'write-idempotent', 'write-dedupable', 'write-unsafe']),
        transport: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .parse(req.body) as unknown as ToolSpec;
    return registerTool(ctx, p.workspaceId, spec, p.userId);
  });

  app.get('/v1/secrets', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    return listSecrets(ctx, p.workspaceId);
  });

  app.put('/v1/secrets/:name', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const { value } = z.object({ value: z.string().min(1) }).parse(req.body);
    return { version: await setSecret(ctx, p.workspaceId, (req.params as { name: string }).name, value, p.userId) };
  });

  app.post('/v1/schedules', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z
      .object({ workflow: z.string(), cron: z.string(), timezone: z.string(), inputs: z.record(z.string(), z.unknown()).default({}), enabled: z.boolean().default(true) })
      .parse(req.body);
    const wf = (await ctx.pool.query(`SELECT id FROM workflows WHERE workspace_id=$1 AND slug=$2`, [p.workspaceId, b.workflow])).rows[0];
    if (!wf) throw notFound(`workflow ${b.workflow}`);
    const id = await upsertSchedule(ctx, p.workspaceId, wf.id, b.cron, b.timezone, b.inputs, b.enabled);
    await audit(ctx, p.workspaceId, p.userId, 'schedule.changed', { id, ...b });
    return (await ctx.pool.query(`SELECT * FROM schedules WHERE id=$1`, [id])).rows[0];
  });

  app.get('/v1/schedules', async (req) => (await ctx.pool.query(`SELECT * FROM schedules WHERE workspace_id=$1`, [req.principal.workspaceId])).rows);

  app.post('/v1/workers/heartbeat', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    const b = z
      .object({
        id: z.string(),
        name: z.string(),
        task_queue: z.string(),
        capabilities: z.record(z.string(), z.unknown()),
        trust_policy: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const existing = (await ctx.pool.query(`SELECT trust_policy FROM workers WHERE id=$1`, [b.id])).rows[0];
    await ctx.pool.query(
      `INSERT INTO workers(id, workspace_id, name, owner_id, task_queue, capabilities, trust_policy) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$3, task_queue=$5, capabilities=$6, trust_policy=$7, last_heartbeat=now()`,
      [b.id, p.workspaceId, b.name, p.userId, b.task_queue, JSON.stringify(b.capabilities), JSON.stringify(b.trust_policy ?? { kind: 'workspace-publishers' })],
    );
    if (existing && JSON.stringify(existing.trust_policy) !== JSON.stringify(b.trust_policy ?? { kind: 'workspace-publishers' })) {
      await audit(ctx, p.workspaceId, p.userId, 'worker.trust_policy_changed', { worker: b.id, trust_policy: b.trust_policy });
    }
    return { ok: true };
  });

  // A worker shutting down says so, so runs report worker_offline at once rather than after 30 s.
  app.post('/v1/workers/:id/offline', async (req) => {
    const p = user(req);
    requireRole(p, 'operator');
    await ctx.pool.query(`UPDATE workers SET last_heartbeat = 'epoch' WHERE id=$1 AND workspace_id=$2 AND owner_id=$3`, [(req.params as { id: string }).id, p.workspaceId, p.userId]);
    return { ok: true };
  });

  app.get('/v1/workers', async (req) =>
    (
      await ctx.pool.query(
        `SELECT id, name, owner_id, task_queue, capabilities, trust_policy, last_heartbeat, (last_heartbeat > now() - interval '30 seconds') AS online FROM workers WHERE workspace_id=$1 ORDER BY name`,
        [req.principal.workspaceId],
      )
    ).rows,
  );

  // Gateway for scripts: run-scoped token only.
  app.post('/v1/gateway/call', async (req) => {
    if (req.principal.kind !== 'run') throw new AzhiError(ErrorClass.authorization, 'gateway calls need a run-scoped token');
    const c = req.principal.claims;
    const b = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}), project: z.array(z.string()).optional() }).parse(req.body);
    const run = (await ctx.pool.query(`SELECT snapshot FROM runs WHERE id=$1 AND workspace_id=$2`, [c.run, c.ws])).rows[0];
    if (!run) throw notFound('run');
    const r = await callTool(ctx, {
      workspaceId: c.ws,
      runId: c.run,
      nodeId: c.node,
      attempt: 1,
      tool: b.tool,
      revision: run.snapshot.tool_revisions?.[b.tool],
      args: b.args,
      project: b.project,
      allowed: c.tools,
    });
    return r;
  });

  app.get('/v1/doctor', async (req) => {
    user(req);
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    checks.push({ name: 'database', ok: true, detail: (await ctx.pool.query('SELECT version()')).rows[0].version.split(' ').slice(0, 2).join(' ') });
    try {
      await temporal?.connection.workflowService.getSystemInfo({});
      checks.push({ name: 'temporal', ok: Boolean(temporal), detail: temporal ? ctx.settings.temporalAddress : 'not connected' });
    } catch (e) {
      checks.push({ name: 'temporal', ok: false, detail: (e as Error).message });
    }
    const builds = (
      await ctx.pool.query(`SELECT interpreter_build, count(*)::int AS open FROM runs WHERE state IN ('queued','running','waiting','cancelling') GROUP BY interpreter_build`)
    ).rows;
    checks.push({ name: 'interpreter builds', ok: builds.length <= 3, detail: `current ${interpreterBuild}; with open runs: ${builds.map((b) => `${b.interpreter_build} (${b.open})`).join(', ') || 'none'} (max 3)` });
    const workers = (await ctx.pool.query(`SELECT count(*)::int AS n FROM workers WHERE workspace_id=$1 AND last_heartbeat > now() - interval '30 seconds'`, [req.principal.workspaceId])).rows[0].n;
    checks.push({ name: 'workers online', ok: workers > 0, detail: String(workers) });
    return { ok: checks.every((c) => c.ok), checks };
  });

  return app;
}

export type { FastifyReply };
