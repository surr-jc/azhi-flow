import type { Client } from '@temporalio/client';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z, ZodError } from 'zod';
import type { ExecutionPlan } from '../compiler/plan.js';
import type { ApprovalNode } from '../definition/types.js';
import { TERMINAL_STATES } from '../runtime/types.js';
import { callTool } from '../gateway/gateway.js';
import type { ToolSpec } from '../gateway/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit, loadCatalog, registerTool, updateToolRepos } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { packageManifest } from '../server/packages.js';
import { addDocuments, createDataset, listDatasets, publishRevision, resolveDatasetRef, retrieve, revokeDocument, tagRevision } from '../knowledge/datasets.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { createRun, getRunDetail, requestCancel, runEvents } from '../server/runs.js';
import { readTranscript, redactor, writeTranscript } from '../agents/transcript.js';
import { listSecrets, resolveSecret, setSecret } from '../server/secrets.js';
import { publishVersion, resolveVersion, upsertSchedule, uploadPackage } from '../server/workflows.js';
import type { Role } from '../db/schema.js';
import { authenticate, requireRole, type Principal } from './auth.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
import { newApiToken } from '../security/tokens.js';
import { newId } from '../lib/ids.js';
import { checkSignature, registerPublisherKey, requireValidSignature, workspaceRoot } from '../server/trust.js';
import { keyId } from '../security/signing.js';
import { isWebPath, registerWebRoutes } from '../web/routes.js';
import { registerBuilderRoutes } from './builder.js';
import { registerEditorRoutes } from './editor.js';
import { registerExampleRoutes } from './examples.js';
import { freshChatgptAuth, keepRenewedChatgptAuth, registerChatgptRoutes } from './chatgpt.js';
import { registerCopilotRoutes } from './copilot.js';
import { registerMissionRoutes } from './mission.js';
import { decideApproval } from '../server/approvals.js';
import { isAuthPath, registerTeamRoutes } from './team.js';
import { registerSlackRoutes, SLACK_INTERACTIONS } from './slack.js';

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
    if (req.url === '/healthz' || isWebPath(req.url) || isAuthPath(req.url) || req.url === SLACK_INTERACTIONS) return;
    req.principal = await authenticate(ctx, req.headers.authorization);
  });

  const user = (req: FastifyRequest) => {
    if (req.principal.kind !== 'user') throw new AzhiError(ErrorClass.authorization, 'run tokens cannot use this endpoint');
    return req.principal;
  };
  const notFound = (what: string) => new AzhiError(ErrorClass.invalidInput, `${what} not found`);

  registerWebRoutes(app);
  registerMissionRoutes(app, ctx);
  registerEditorRoutes(app, ctx);
  registerBuilderRoutes(app, ctx);
  registerExampleRoutes(app, ctx);
  registerCopilotRoutes(app, ctx);
  registerChatgptRoutes(app, ctx);
  registerTeamRoutes(app, ctx);
  registerSlackRoutes(app, ctx, temporal);
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

  // Signs an unsigned draft after the fact (mission control signs in the browser, `azhi example install` on the
  // CLI); workers only run signed packages. The signature must be the caller's own, for this package.
  app.post('/v1/versions/:id/signature', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const { id } = req.params as { id: string };
    const { signature } = z.object({ signature: z.record(z.string(), z.unknown()) }).parse(req.body);
    const current = (await ctx.pool.query(`SELECT package_hash, signature FROM workflow_versions WHERE id=$1 AND workspace_id=$2`, [id, p.workspaceId])).rows[0];
    if (!current) throw notFound('workflow version');
    if (current.signature) return { id, signed: true, changed: false };
    await requireValidSignature(ctx, p.workspaceId, signature, current.package_hash, p.userId);
    await ctx.pool.query(`UPDATE workflow_versions SET signature=$2 WHERE id=$1 AND signature IS NULL`, [id, JSON.stringify(signature)]);
    await audit(ctx, p.workspaceId, p.userId, 'version.signed', { id, package_hash: current.package_hash });
    return { id, signed: true, changed: true };
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
    // `token: false` invites someone who will sign in with SSO (claimed by their verified email).
    const b = z
      .object({ display_name: z.string(), email: z.string().optional(), role: z.enum(['admin', 'author', 'operator', 'viewer']), token: z.boolean().default(true) })
      .parse(req.body);
    if (b.role === 'admin' && p.role !== 'owner') throw new AzhiError(ErrorClass.authorization, 'only the owner can make admins');
    const id = newId('usr');
    await ctx.pool.query(`INSERT INTO users(id, workspace_id, email, display_name, role) VALUES ($1,$2,$3,$4,$5)`, [id, p.workspaceId, b.email ?? null, b.display_name, b.role]);
    const t = b.token ? newApiToken() : undefined;
    if (t) await ctx.pool.query(`INSERT INTO api_tokens(id, workspace_id, user_id, name, token_hash) VALUES ($1,$2,$3,$4,$5)`, [newId('tok'), p.workspaceId, id, b.display_name, t.hash]);
    await audit(ctx, p.workspaceId, p.userId, 'user.created', { user: id, role: b.role, email: b.email ?? null });
    return { id, role: b.role, token: t?.token };
  });

  app.get('/v1/users', async (req) => {
    const p = user(req);
    return (
      await ctx.pool.query(
        `SELECT u.id, u.display_name, u.email, u.role, u.created_at, u.disabled_at, u.slack_user_id, u.oidc_subject IS NOT NULL AS sso,
           (SELECT count(*)::int FROM api_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens
         FROM users u WHERE u.workspace_id=$1 ORDER BY u.created_at`,
        [p.workspaceId],
      )
    ).rows;
  });

  // Runs
  app.post('/v1/runs', async (req, reply) => {
    const p = user(req);
    requireRole(p, 'operator');
    const body = z
      .object({
        version: z.string(),
        inputs: z.record(z.string(), z.unknown()).default({}),
        test: z.boolean().optional(),
        node: z.string().optional(),
        fixtures: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    if (body.node && !body.test) throw new AzhiError(ErrorClass.invalidInput, 'running a single node requires test: true (writes are mocked)');
    const v = await resolveVersion(ctx, p.workspaceId, body.version);
    if (!v) throw notFound(`workflow version ${body.version}`);
    // A run whose plan has blockers is refused before anything executes. Test runs are exempt:
    // `azhi test-node` mocks writes and is how authors debug an incomplete setup.
    const plan = await buildRunPlan(ctx, p.workspaceId, v, { userId: p.userId, role: p.role });
    if (!body.test) {
      if (!plan.ok) {
        const first = plan.blockers[0]!;
        throw new AzhiError(first.code === 'worker_trust_denied' ? ErrorClass.workerTrustDenied : ErrorClass.unsupportedCapability, `run plan has ${plan.blockers.length} blocker(s): ${plan.blockers.map((b) => (b.node ? `${b.node}: ` : '') + b.message).join('; ')}`, { blockers: plan.blockers });
      }
    }
    const r = await createRun(ctx, p.workspaceId, { version: v, inputs: body.inputs, trigger: body.test ? 'test' : 'api', test: body.test, createdBy: p.userId, interpreterBuild, plan, ...(body.node ? { testNode: { node: body.node, fixtures: body.fixtures ?? {} } } : {}) });
    return reply.status(202).send({ run_id: r.runId });
  });

  app.get('/v1/runs', async (req) => {
    const p = user(req);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(20),
        state: z.string().optional(),
        workflow: z.string().optional(),
        before: z.string().datetime({ offset: true }).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        // Text found in the run's inputs, or the start of its id.
        q: z.string().trim().min(1).max(200).optional(),
      })
      .parse(req.query);
    const esc = q.q?.replace(/[\\%_]/g, (c) => `\\${c}`);
    return (
      await ctx.pool.query(
        `SELECT r.id, r.state, r.flags, r.trigger, r.test, r.inputs, r.created_at, r.ended_at, w.slug AS workflow, v.version FROM runs r
         JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
         WHERE r.workspace_id=$1 AND ($3::text[] IS NULL OR r.state = ANY($3)) AND ($4::text IS NULL OR w.slug = $4) AND ($5::timestamptz IS NULL OR r.created_at < $5)
           AND ($6::timestamptz IS NULL OR r.created_at >= $6) AND ($7::text IS NULL OR r.inputs::text ILIKE $7 OR r.id LIKE $8)
         ORDER BY r.created_at DESC LIMIT $2`,
        [p.workspaceId, q.limit, q.state ? q.state.split(',') : null, q.workflow ?? null, q.before ?? null, q.since ?? null, esc ? `%${esc}%` : null, esc ? `${esc}%` : null],
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

  // Knowledge datasets (spec section 11)
  app.post('/v1/datasets', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const b = z
      .object({ name: z.string(), trusted: z.boolean().optional(), acl: z.object({ roles: z.array(z.string()).optional(), users: z.array(z.string()).optional() }).optional() })
      .parse(req.body);
    const d = await createDataset(ctx, p.workspaceId, b);
    await audit(ctx, p.workspaceId, p.userId, 'dataset.created', { name: b.name, trusted: d.trusted });
    return d;
  });

  app.get('/v1/datasets', async (req) => listDatasets(ctx, user(req).workspaceId));

  app.post('/v1/datasets/:name/documents', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const b = z.object({ documents: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1) }).parse(req.body);
    return { documents: await addDocuments(ctx, p.workspaceId, (req.params as { name: string }).name, b.documents) };
  });

  app.delete('/v1/datasets/:name/documents', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const { path } = z.object({ path: z.string() }).parse(req.query);
    const name = (req.params as { name: string }).name;
    await revokeDocument(ctx, p.workspaceId, name, path);
    await audit(ctx, p.workspaceId, p.userId, 'dataset.document_revoked', { name, path });
    return { ok: true };
  });

  app.post('/v1/datasets/:name/publish', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const b = z.object({ tag: z.string().optional() }).parse(req.body ?? {});
    const name = (req.params as { name: string }).name;
    const r = await publishRevision(ctx, p.workspaceId, name, b.tag);
    await audit(ctx, p.workspaceId, p.userId, 'dataset.published', { name, ...r, tag: b.tag });
    return r;
  });

  app.put('/v1/datasets/:name/tags/:tag', async (req) => {
    const p = user(req);
    requireRole(p, 'author');
    const { name, tag } = req.params as { name: string; tag: string };
    const b = z.object({ revision: z.number().int().min(1) }).parse(req.body);
    await tagRevision(ctx, p.workspaceId, name, tag, b.revision);
    await audit(ctx, p.workspaceId, p.userId, 'dataset.tagged', { name, tag, revision: b.revision });
    return { ok: true };
  });

  app.post('/v1/datasets/:ref/search', async (req) => {
    const p = user(req);
    const ref = (req.params as { ref: string }).ref;
    const b = z.object({ query: z.string(), top_k: z.number().int().min(1).max(50).optional() }).parse(req.body);
    const r = await resolveDatasetRef(ctx, p.workspaceId, ref);
    if (!r) throw notFound(`dataset ${ref}`);
    return { revision: r.revision, chunks: await retrieve(ctx, p.workspaceId, { pinned: [{ ref, revision: r.revision }], query: b.query, topK: b.top_k, principal: { userId: p.userId, role: p.role } }) };
  });

  // Approvals (spec section 7): the API checks the approver's role and the decision schema, then
  // signals the interpreter, which records the first decision and resumes the run.
  app.post('/v1/runs/:id/approvals', async (req, reply) => {
    const p = user(req);
    const { id } = req.params as { id: string };
    const b = z.object({ node: z.string(), decision: z.enum(['approved', 'rejected']), data: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    await decideApproval(ctx, temporal, p, id, b);
    return reply.status(202).send({ ok: true });
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

  // Adds or removes repositories on a GitHub-style tool without re-registering it by hand.
  app.post('/v1/tools/:ref/repos', async (req) => {
    const p = user(req);
    requireRole(p, 'admin');
    const b = z.object({ add: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repositories are owner/name')).optional(), remove: z.array(z.string()).optional() }).parse(req.body ?? {});
    return updateToolRepos(ctx, p.workspaceId, decodeURIComponent((req.params as { ref: string }).ref), b, p.userId);
  });

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
    const run = (
      await ctx.pool.query(`SELECT r.snapshot, r.test, v.plan FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1 AND r.workspace_id=$2`, [c.run, c.ws])
    ).rows[0];
    if (!run) throw notFound('run');
    // ADR-10 at the gateway: a tainted agent (or a harness acting for one) cannot call a write
    // tool unless it is marked safe for tainted callers.
    const node = (run.plan as ExecutionPlan).nodes.find((n) => n.id === c.node);
    const agentTool = node?.agentTools?.find((t) => t.ref === b.tool);
    const tainted = (run.plan as ExecutionPlan).taint?.tainted?.[c.node];
    if (tainted && agentTool && agentTool.effect !== 'read' && !agentTool.safeForTainted) {
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'gateway.refused',$3,$4)`, [c.ws, c.run, c.node, JSON.stringify({ tool: b.tool, reason: 'tainted_write' })]);
      throw new AzhiError(ErrorClass.authorization, `refused: node ${c.node} is tainted (${tainted}) and ${b.tool} is a ${agentTool.effect} tool not marked safe_for_tainted`);
    }
    if (run.test && agentTool && agentTool.effect !== 'read') return { output: { mocked: true, tool: b.tool, args: b.args }, observation: { source: 'mock' } };
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

  // A harness fetches its provider key with the run token; only credentials named in the token.
  app.get('/v1/gateway/credentials/:name', async (req) => {
    if (req.principal.kind !== 'run') throw new AzhiError(ErrorClass.authorization, 'credentials need a run-scoped token');
    const c = req.principal.claims;
    const name = (req.params as { name: string }).name;
    if (!c.creds?.includes(name)) throw new AzhiError(ErrorClass.authorization, `this run token may not read credential ${name}`);
    const s = await resolveSecret(ctx, c.ws, name);
    if (!s) throw notFound(`credential ${name}`);
    await audit(ctx, c.ws, `run:${c.run}`, 'credential.read', { name, node: c.node });
    // A ChatGPT sign-in is renewed here when it would expire during the step (only Azhi may renew it).
    return { value: await freshChatgptAuth(ctx, c.ws, name, s.value) };
  });

  // A harness sends back a ChatGPT sign-in OpenCode renewed during its step (OpenAI rotates the refresh token).
  app.post('/v1/gateway/credentials/:name/renewed', async (req) => {
    if (req.principal.kind !== 'run') throw new AzhiError(ErrorClass.authorization, 'credentials need a run-scoped token');
    const c = req.principal.claims;
    const name = (req.params as { name: string }).name;
    if (!c.creds?.includes(name)) throw new AzhiError(ErrorClass.authorization, `this run token may not update credential ${name}`);
    const b = z.object({ value: z.string().min(2).max(20_000) }).parse(req.body);
    return { kept: await keepRenewedChatgptAuth(ctx, c.ws, name, b.value, `run:${c.run}`) };
  });

  // A harness streams its agent transcript with the run token, for its own node only. Entries are
  // redacted again here, with the values of the credentials the token may read.
  app.post('/v1/gateway/transcript', async (req) => {
    if (req.principal.kind !== 'run') throw new AzhiError(ErrorClass.authorization, 'transcripts need a run-scoped token');
    const c = req.principal.claims;
    if (!ctx.settings.agentTranscripts) return { stored: 0, enabled: false };
    const b = z.object({ attempt: z.number().int().min(1).max(1000).default(1), entries: z.array(z.record(z.string(), z.unknown())).max(500) }).parse(req.body);
    const secrets = await Promise.all((c.creds ?? []).map(async (n) => (await resolveSecret(ctx, c.ws, n).catch(() => undefined))?.value));
    const stored = await writeTranscript(ctx.pool, { workspaceId: c.ws, runId: c.run, nodeId: c.node, attempt: b.attempt }, b.entries as never, redactor(secrets));
    return { stored, enabled: true };
  });

  app.get('/v1/runs/:id/transcript', async (req) => {
    const p = user(req);
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), node: z.string().optional() }).parse(req.query);
    const run = (await ctx.pool.query(`SELECT 1 FROM runs WHERE id=$1 AND workspace_id=$2`, [(req.params as { id: string }).id, p.workspaceId])).rows[0];
    if (!run) throw notFound('run');
    return { enabled: ctx.settings.agentTranscripts, ...(await readTranscript(ctx.pool, p.workspaceId, (req.params as { id: string }).id, q)) };
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
    // OpenCode steps search with ripgrep; without it on the worker, OpenCode downloads a copy on every step.
    const ocWorkers = (
      await ctx.pool.query(`SELECT name, capabilities FROM workers WHERE workspace_id=$1 AND last_heartbeat > now() - interval '30 seconds' AND capabilities->'runtimes' ? 'opencode'`, [req.principal.workspaceId])
    ).rows as Array<{ name: string; capabilities: { runtimes?: { ripgrep?: { version: string } } } }>;
    if (ocWorkers.length) {
      const missing = ocWorkers.filter((w) => !w.capabilities.runtimes?.ripgrep).map((w) => w.name);
      checks.push({ name: 'ripgrep on OpenCode workers', ok: missing.length === 0, detail: missing.length ? `missing on ${missing.join(', ')}; run 'azhi setup' on that host` : `${ocWorkers.length} worker(s)` });
    }
    return { ok: checks.every((c) => c.ok), checks };
  });

  return app;
}

export type { FastifyReply };
